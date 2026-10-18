/** Reduces fetched content to plain text and flags text that looks like it is
 * addressed to the model. Flags help the owner decide; they are not a security
 * boundary. Fetched content stays untrusted whatever this reports. */
export interface Sanitized {
  text: string;
  flags: Array<{ rule: string; count: number }>;
  changed: boolean;
}
const hiddenChars = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const rules: Array<[string, RegExp]> = [
  [
    "instruction_override",
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|guidelines?)\b/gi,
  ],
  ["role_marker", /(^|\n)\s*(system|assistant|developer)\s*(prompt)?\s*:/gi],
  [
    "model_addressed",
    /\b(you are now|act as|pretend to be|new instructions?|as an ai (assistant|model))\b/gi,
  ],
  [
    "tool_or_file_request",
    /\b(delete|remove|overwrite|exfiltrate|upload|send)\b[^.\n]{0,60}\b(files?|repository|repo|secrets?|credentials?|tokens?|\.env|api keys?)\b/gi,
  ],
  [
    "approval_claim",
    /\b(the (user|owner) (has )?(approved|authorized|authorised|allowed)|pre-?approved|approval (granted|given))\b/gi,
  ],
  ["encoded_blob", /[A-Za-z0-9+/]{200,}={0,2}/g],
];
const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const looksLikeHtml = (text: string) =>
  /<(!doctype|html|head|body|div|p|span|a|script|style|h[1-6]|ul|ol|li|table)[\s>]/i.test(
    text.slice(0, 4096),
  );
export function sanitize(raw: string, limit = 16_384): Sanitized {
  const flags: Sanitized["flags"] = [];
  const flag = (rule: string, count: number) => {
    if (count) flags.push({ rule, count });
  };
  let text = raw;
  if (looksLikeHtml(text)) {
    // Comments, scripts, styles and hidden elements are where payloads hide.
    const hidden = (
      text.match(
        /<!--[\s\S]*?-->|<(script|style|noscript|template)[\s\S]*?<\/\1>|<[^>]+(hidden|display\s*:\s*none|visibility\s*:\s*hidden|aria-hidden="true")[^>]*>/gi,
      ) ?? []
    ).length;
    flag("hidden_markup", hidden);
    text = text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => entities[e] ?? e);
  }
  flag("hidden_characters", (text.match(hiddenChars) ?? []).length);
  text = text
    .replace(hiddenChars, "")
    .replace(controls, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  for (const [rule, pattern] of rules)
    flag(rule, (text.match(pattern) ?? []).length);
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    flags,
    changed: text !== raw,
  };
}
