import { check, id, type Session } from "../core.js";
import type { Integration } from "../identity.js";
import { ContainedOpenCode } from "./contained-opencode.js";
import { SpecialistPool } from "./specialist-pool.js";
import type { Operation } from "../operations.js";
import {
  IntegrationBridge,
  boundRelay,
  type BridgeTransport,
} from "./bridge.js";

export interface ExternalOpenCodeOptions {
  integration: Integration;
  transport: BridgeTransport;
  repository: string;
  certificate: string;
  specialist?: Session;
  onFailure?: (error: unknown) => void;
}
/** Created by the operator's host process, never by the web controls or model.
 * The same bridge can claim an already engine-admitted specialist. */
export class ExternalOpenCode {
  readonly bridge: IntegrationBridge;
  private runtime?: ContainedOpenCode;
  private stopping?: Promise<void>;
  private registered = false;
  private started = false;
  private specialists?: SpecialistPool;
  constructor(readonly options: ExternalOpenCodeOptions) {
    check(options.integration.runtime === "opencode", "runtime_identity");
    check(
      !options.specialist ||
        options.specialist.repository === options.repository,
      "specialist_repository",
    );
    this.bridge = new IntegrationBridge(
      options.integration,
      options.transport,
      {
        repository: options.repository,
        runtimeSession: options.specialist?.runtimeSession ?? id(),
        connection: options.specialist?.connection ?? id(),
      },
      (error) => this.failure(error),
    );
    if (!options.specialist)
      this.specialists = new SpecialistPool(
        this.bridge,
        (specialist) =>
          new ExternalOpenCode({
            ...options,
            specialist,
            onFailure: (error) => this.failure(error),
          }),
      );
  }
  private failure(error: unknown) {
    if (this.stopping) return;
    this.options.onFailure?.(error);
    void this.stop().catch((cleanupError) =>
      this.options.onFailure?.(cleanupError),
    );
  }
  async start(goal?: string) {
    check(!this.started, "runtime_already_started");
    this.started = true;
    try {
      const session = this.options.specialist
        ? await this.bridge.registerSpecialist(this.options.specialist.session)
        : await this.bridge.register();
      this.registered = true;
      const launch = await this.bridge.prepareRuntime(
        this.options.certificate,
        goal,
      );
      this.runtime = new ContainedOpenCode({
        image: launch.image,
        name: launch.name,
        runtimeSession: launch.runtimeSession,
        connection: launch.connection,
        model: launch.model,
        relay: (rawSession) => {
          const relay = boundRelay(this.bridge, rawSession);
          return {
            ...relay,
            execute: async (request) => {
              const operation = await relay.execute(request);
              return request.tool === "delegate" && this.specialists
                ? this.specialists.delegated(operation as Operation)
                : operation;
            },
          };
        },
        attached: async (container) => {
          await this.bridge.attachRuntime(container);
        },
        onFailure: (error) => this.failure(error),
      });
      const ready = await this.runtime.start();
      return {
        session,
        container: ready.container,
        runtimeSession: ready.session,
        engineSession: session.session,
      };
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        this.options.onFailure?.(cleanupError);
      }
      throw error;
    }
  }
  prompt(text: string) {
    check(this.runtime && !this.stopping, "runtime_not_started");
    return this.runtime.prompt(text);
  }
  stop(): Promise<void> {
    return (this.stopping ??= this.cleanup());
  }
  quiesce() {
    this.runtime?.quiesce();
    this.specialists?.quiesce();
  }
  /** Called only after the engine has terminated and cleaned this specialist. */
  release(): Promise<void> {
    this.quiesce();
    this.bridge.stop();
    return (this.stopping ??= this.runtime?.stop() ?? Promise.resolve());
  }
  private async cleanup() {
    this.quiesce();
    let failure: unknown;
    try {
      await this.specialists?.stop();
    } catch (error) {
      failure = error;
    }
    if (this.registered) {
      try {
        const outcome = await this.bridge.stopRuntime();
        check(
          outcome.status === "stopped",
          "runtime_cleanup_requires_reconciliation",
        );
      } catch (error) {
        failure = error;
      }
    }
    try {
      await this.runtime?.stop();
    } catch (error) {
      failure ??= error;
    }
    this.bridge.stop();
    if (failure) throw failure;
  }
}
