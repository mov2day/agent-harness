#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/random.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#ifdef __linux__
#include <linux/openat2.h>
#include <sys/syscall.h>
#include <linux/fs.h>
#endif
#ifdef __APPLE__
#include <sys/attr.h>
#endif
#define LIMIT 2000000
#define DEPTH 128
static int cleanup_parent=-1;
static char cleanup_name[96];
static void cleanup(void){if(cleanup_parent>=0&&cleanup_name[0])unlinkat(cleanup_parent,cleanup_name,0);}
static _Noreturn void deny(const char *message) { fprintf(stderr,"%s: %s\n",message,strerror(errno));exit(1); }
static int same(struct stat a,struct stat b){return a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&((a.st_mode&S_IFMT)==(b.st_mode&S_IFMT));}
static int secure_open(int parent,const char *path,int flags,mode_t mode){
#ifdef __linux__
  struct open_how how={.flags=(uint64_t)(flags|O_CLOEXEC|O_NOFOLLOW),.mode=mode,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
  return (int)syscall(SYS_openat2,parent,path,&how,sizeof(how));
#elif defined(__APPLE__)
  return openat(parent,path,flags|O_CLOEXEC|O_NOFOLLOW,mode);
#else
#error Unsupported platform: do not downgrade path resolution
#endif
}
struct chain {int fd[DEPTH];char *names[DEPTH];struct stat identity[DEPTH];int count;char *leaf;char *copy;};
static struct chain resolve_parent(int root,const char *path){
  struct chain c={.count=1};c.fd[0]=dup(root);if(c.fd[0]<0||fstat(root,&c.identity[0]))deny("root stat");
  if(!path[0]||path[0]=='/'||strchr(path,'\\')||strlen(path)>2048||path[strlen(path)-1]=='/'||strstr(path,"//"))deny("invalid path");
  c.copy=strdup(path);char *save=NULL,*part=strtok_r(c.copy,"/",&save);
  while(part){if(!strcmp(part,".")||!strcmp(part,".."))deny("path traversal");char *next=strtok_r(NULL,"/",&save);if(!next){c.leaf=part;break;}
    if(c.count>=DEPTH)deny("path depth");int parent=c.fd[c.count-1],fd=secure_open(parent,part,O_RDONLY|O_DIRECTORY,0);if(fd<0)deny("intermediate resolution");
    struct stat entry,opened;if(fstatat(parent,part,&entry,AT_SYMLINK_NOFOLLOW)||fstat(fd,&opened)||!same(entry,opened)||opened.st_dev!=c.identity[0].st_dev)deny("intermediate identity");
    c.names[c.count]=part;c.fd[c.count]=fd;c.identity[c.count]=opened;c.count++;part=next;
  }return c;
}
static void revalidate(struct chain *c,int root,const char *root_path){
  struct stat current,entry;if(fstat(root,&current)||lstat(root_path,&entry)||!same(current,entry)||!same(current,c->identity[0]))deny("root changed");
  for(int i=1;i<c->count;i++)if(fstat(c->fd[i],&current)||fstatat(c->fd[i-1],c->names[i],&entry,AT_SYMLINK_NOFOLLOW)||!same(current,entry)||!same(current,c->identity[i])||current.st_dev!=c->identity[0].st_dev)deny("ancestor changed");
}
static int leaf(struct chain *c){
  int fd=secure_open(c->fd[c->count-1],c->leaf,O_RDONLY,0);if(fd<0){if(errno==ENOENT)return -1;deny("leaf resolution");}
  struct stat s,entry;if(fstat(fd,&s)||fstatat(c->fd[c->count-1],c->leaf,&entry,AT_SYMLINK_NOFOLLOW)||!same(s,entry)||!S_ISREG(s.st_mode)||s.st_nlink!=1||s.st_dev!=c->identity[0].st_dev||s.st_size>LIMIT)deny("unsafe leaf");return fd;
}
static void expected(int fd,const char *filename){
  if(!strcmp(filename,"-")){if(fd>=0)deny("expected absent target");return;}
  if(fd<0)deny("expected existing target");int other=open(filename,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(other<0)deny("expected content");
  char a[8192],b[8192];ssize_t an,bn;lseek(fd,0,SEEK_SET);do{an=read(fd,a,sizeof(a));bn=read(other,b,sizeof(b));if(an<0||bn<0||an!=bn||memcmp(a,b,(size_t)an))deny("base conflict");}while(an>0);close(other);lseek(fd,0,SEEK_SET);
}
static void copy(int from,int to){char buf[8192];ssize_t n;size_t total=0;while((n=read(from,buf,sizeof(buf)))>0){total+=(size_t)n;if(total>LIMIT)deny("content limit");ssize_t sent=0;while(sent<n){ssize_t w=write(to,buf+sent,(size_t)(n-sent));if(w<=0)deny("write failed");sent+=w;}}if(n<0)deny("read failed");}
int main(int argc,char **argv){
  if(argc<7){fprintf(stderr,"usage: helper ROOT DEV INO OP PATH EXPECTED [CONTENT|TARGET]\n");return 2;}
  int root=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat rs;if(root<0||fstat(root,&rs))deny("open root");
  if((uint64_t)rs.st_dev!=strtoull(argv[2],NULL,10)||(uint64_t)rs.st_ino!=strtoull(argv[3],NULL,10))deny("root identity");
  struct chain c=resolve_parent(root,argv[5]);int parent=c.fd[c.count-1];int fd=leaf(&c);
  if(!strcmp(argv[4],"metadata")){if(fd<0)return 44;struct stat st;if(fstat(fd,&st))deny("metadata");revalidate(&c,root,argv[1]);printf("{\"mode\":%u,\"size\":%lld,\"device\":%llu,\"inode\":%llu}\n",(unsigned)(st.st_mode&0777),(long long)st.st_size,(unsigned long long)st.st_dev,(unsigned long long)st.st_ino);return 0;}
  if(!strcmp(argv[4],"read")){if(fd<0)return 44;revalidate(&c,root,argv[1]);copy(fd,STDOUT_FILENO);return 0;}
  expected(fd,argv[6]);
#ifdef HARNESS_TESTING
  if(getenv("HARNESS_TEST_PAUSE")){fputs("READY\n",stdout);fflush(stdout);if(getchar()!='g')deny("test admission");}
#endif
  if(!strcmp(argv[4],"replace")){
    if(argc!=8)deny("content argument");int content=open(argv[7],O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(content<0)deny("content file");
    unsigned int random; if(getentropy(&random,sizeof(random)))deny("random source"); char temp[96];snprintf(temp,sizeof(temp),".harness-effect-%ld-%u",(long)getpid(),random);
    atexit(cleanup);cleanup_parent=parent;strcpy(cleanup_name,temp);int output=secure_open(parent,temp,O_WRONLY|O_CREAT|O_EXCL,0600);if(output<0)deny("temporary create");
    copy(content,output);if(fd>=0){struct stat st;if(fstat(fd,&st)||fchmod(output,st.st_mode&0777))deny("mode preservation");}
    if(fsync(output))deny("content durability");revalidate(&c,root,argv[1]);int current=leaf(&c);expected(current,argv[6]);
    if(fd>=0){struct stat a,b;if(current<0||fstat(fd,&a)||fstat(current,&b)||!same(a,b))deny("leaf replaced");}
    if(renameat(parent,temp,parent,c.leaf))deny("replacement");cleanup_name[0]=0;if(fsync(parent))deny("directory durability");return 0;
  }
  revalidate(&c,root,argv[1]);int current=leaf(&c);expected(current,argv[6]);
  if(fd<0||current<0)deny("missing mutation target");struct stat a,b;if(fstat(fd,&a)||fstat(current,&b)||!same(a,b))deny("leaf changed");
  if(!strcmp(argv[4],"delete")){if(unlinkat(parent,c.leaf,0)||fsync(parent))deny("delete");return 0;}
  if(!strcmp(argv[4],"rename")&&argc==8){
    struct chain dest=resolve_parent(root,argv[7]);revalidate(&dest,root,argv[1]);if(leaf(&dest)>=0)deny("destination exists");
    revalidate(&c,root,argv[1]);
#ifdef __linux__
    if(syscall(SYS_renameat2,parent,c.leaf,dest.fd[dest.count-1],dest.leaf,RENAME_NOREPLACE))deny("rename");
#else
    if(renameatx_np(parent,c.leaf,dest.fd[dest.count-1],dest.leaf,RENAME_EXCL))deny("rename");
#endif
    if(fsync(parent)||fsync(dest.fd[dest.count-1]))deny("rename durability");return 0;
  }
  deny("unknown operation");return 1;
}
