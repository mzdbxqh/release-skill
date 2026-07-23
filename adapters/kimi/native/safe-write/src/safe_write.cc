/**
 * Node-API safe write addon — identity-bound / fd-relative primitives.
 *
 * All directory traversal uses openat() with O_NOFOLLOW | O_CLOEXEC.
 * openRoot walks from "/" one segment at a time to prevent ancestor-symlink
 * attacks. readFile opens via openat(O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC)
 * to prevent FIFO blocking, validates via fstat on the fd (regular, nlink=1),
 * reads all bytes, then performs post-read identity verification.
 *
 * createTemp validates Buffer data and mode (0..0777), writes data with
 * EINTR/partial-write handling, applies fchmod for exact mode, and returns
 * a TempToken bound to the open temp fd, dup'd directory fd, creation-time
 * dev/ino, temp name, and active/committed state. The TempToken object is
 * tagged with napi_type_tag for identity verification.
 *
 * rename verifies temp-file identity via the token's fd, then executes an
 * atomic no-replace rename, verifies target identity (dev/ino/nlink/type),
 * fsyncs the directory, and consumes the token.
 *
 * abortTemp only unlinks when identity matches (dev/ino/type + nlink==1).
 * chmod uses fd-relative openat + fchmod (not path-based fchmodat).
 *
 * All error messages expose only syscall, errno, and safe segment —
 * never absolute paths.
 *
 * @file native/safe-write/src/safe_write.cc
 */

// Platform feature macros must come before all other includes.
#if defined(__APPLE__)
#  ifndef _DARWIN_C_SOURCE
#    define _DARWIN_C_SOURCE
#  endif
#endif

#include <node_api.h>

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#  include <sys/syscall.h>
#endif

// ---------------------------------------------------------------------------
// Platform-specific timespec accessors for st_mtim/st_ctim.
// macOS uses st_mtimespec/st_ctimespec; Linux uses st_mtim/st_ctim.
// ---------------------------------------------------------------------------

#if defined(__APPLE__)
#  define ST_MTIM_NS(st) \
     ((int64_t)(st).st_mtimespec.tv_sec * 1000000000LL + (st).st_mtimespec.tv_nsec)
#  define ST_CTIM_NS(st) \
     ((int64_t)(st).st_ctimespec.tv_sec * 1000000000LL + (st).st_ctimespec.tv_nsec)
#elif defined(__linux__)
#  define ST_MTIM_NS(st) \
     ((int64_t)(st).st_mtim.tv_sec * 1000000000LL + (st).st_mtim.tv_nsec)
#  define ST_CTIM_NS(st) \
     ((int64_t)(st).st_ctim.tv_sec * 1000000000LL + (st).st_ctim.tv_nsec)
#else
#  define ST_MTIM_NS(st) ((int64_t)(st).st_mtime * 1000000000LL)
#  define ST_CTIM_NS(st) ((int64_t)(st).st_ctime * 1000000000LL)
#endif

// ---------------------------------------------------------------------------
// Type tags for N-API object identity verification.
// Random 64-bit values baked into the binary to prevent cross-addon forgery.
// ---------------------------------------------------------------------------

static constexpr uint64_t kDirHandleTag = 0x8a3f1b2c4d5e6f70ULL;
static constexpr uint64_t kTempTokenTag = 0xd4e5f6a7b8c90123ULL;

// ---------------------------------------------------------------------------
// Test seam for deterministic N-API failure injection.
// Only available in test builds (SAFE_WRITE_TEST_SEAM=1).
// Production builds never define this, so the test hook does not exist.
// ---------------------------------------------------------------------------

#ifdef SAFE_WRITE_TEST_SEAM
#include <unordered_map>
#include <mutex>

// Test seam state: maps failure point names to failure counts.
// A count of -1 means "fail on every call".
static std::mutex g_test_seam_mutex;
static std::unordered_map<std::string, int> g_test_seam_failures;

// Test seam statistics: tracks calls and failures for each failure point.
static std::unordered_map<std::string, int> g_test_seam_calls;
static std::unordered_map<std::string, int> g_test_seam_failed;

// Check if a test seam failure should be triggered.
// Returns true if the failure should be injected.
static bool TestSeamShouldFail(const char* point) {
  std::lock_guard<std::mutex> lock(g_test_seam_mutex);
  g_test_seam_calls[point]++;
  auto it = g_test_seam_failures.find(point);
  if (it != g_test_seam_failures.end()) {
    if (it->second == -1) {
      // Fail every time
      g_test_seam_failed[point]++;
      return true;
    }
    if (it->second > 0) {
      // Fail N times
      it->second--;
      g_test_seam_failed[point]++;
      return true;
    }
  }
  return false;
}

// Test seam failure point names for CreateTemp N-API calls.
static const char* kSeamCreateObject = "createTemp:napi_create_object";
static const char* kSeamCreateString = "createTemp:napi_create_string_utf8";
static const char* kSeamCreateExternal = "createTemp:napi_create_external";
static const char* kSeamSetProperty = "createTemp:napi_set_named_property";
static const char* kSeamTypeTag = "createTemp:napi_type_tag_object";

// Test seam failure point names for other functions.
static const char* kSeamOpenRootCreateObject = "openRoot:napi_create_object";
static const char* kSeamOpenDirCreateObject = "openDir:napi_create_object";
static const char* kSeamReadFileCreateObject = "readFile:napi_create_object";
static const char* kSeamAbortTempCreateObject = "abortTemp:napi_create_object";
static const char* kSeamAbortUnlink = "abortTemp:unlinkat";

// Reset all test seam state.
static void TestSeamReset() {
  std::lock_guard<std::mutex> lock(g_test_seam_mutex);
  g_test_seam_failures.clear();
  g_test_seam_calls.clear();
  g_test_seam_failed.clear();
}

// Configure a test seam failure point.
// count: -1 = fail every time, 0 = don't fail, N = fail N times.
static void TestSeamConfigure(const char* point, int count) {
  std::lock_guard<std::mutex> lock(g_test_seam_mutex);
  g_test_seam_failures[point] = count;
}

// Get the number of times a failure point was triggered.
static int TestSeamGetFailedCount(const char* point) {
  std::lock_guard<std::mutex> lock(g_test_seam_mutex);
  return g_test_seam_failed[point];
}

// Get the number of times a failure point was called.
static int TestSeamGetCallCount(const char* point) {
  std::lock_guard<std::mutex> lock(g_test_seam_mutex);
  return g_test_seam_calls[point];
}
#endif  // SAFE_WRITE_TEST_SEAM

// ---------------------------------------------------------------------------
// N-API status check macro
//
// NAPI_CHECK — for napi_value-returning functions; returns nullptr on failure.
// ---------------------------------------------------------------------------

#define NAPI_CHECK(call)                                                       \
  do {                                                                         \
    napi_status _s = (call);                                                   \
    if (_s != napi_ok) {                                                       \
      napi_throw_error(env, nullptr, "N-API call failed: " #call);            \
      return nullptr;                                                          \
    }                                                                          \
  } while (0)

// ---------------------------------------------------------------------------
// Platform-specific atomic no-replace rename
// ---------------------------------------------------------------------------

#if defined(__APPLE__)
#  include <sys/errno.h>
#  ifndef RENAME_EXCL
#    define RENAME_EXCL 0x00000001
#  endif
static int safe_rename_noreplace(int src_dirfd, const char* src_name,
                                 int dst_dirfd, const char* dst_name) {
  return renameatx_np(src_dirfd, src_name, dst_dirfd, dst_name, RENAME_EXCL);
}
static int safe_rename_exchange(int src_dirfd, const char* src_name,
                                int dst_dirfd, const char* dst_name) {
  return renameatx_np(src_dirfd, src_name, dst_dirfd, dst_name, RENAME_SWAP);
}

#elif defined(__linux__)
#  ifndef RENAME_NOREPLACE
#    define RENAME_NOREPLACE (1 << 0)
#  endif
#  ifndef RENAME_EXCHANGE
#    define RENAME_EXCHANGE (1 << 1)
#  endif
static int safe_rename_noreplace(int src_dirfd, const char* src_name,
                                 int dst_dirfd, const char* dst_name) {
  return static_cast<int>(
      syscall(SYS_renameat2, src_dirfd, src_name, dst_dirfd, dst_name,
              static_cast<unsigned>(RENAME_NOREPLACE)));
}
static int safe_rename_exchange(int src_dirfd, const char* src_name,
                                int dst_dirfd, const char* dst_name) {
  return static_cast<int>(
      syscall(SYS_renameat2, src_dirfd, src_name, dst_dirfd, dst_name,
              static_cast<unsigned>(RENAME_EXCHANGE)));
}

#else
static int safe_rename_noreplace(int /*src_dirfd*/, const char* /*src_name*/,
                                 int /*dst_dirfd*/, const char* /*dst_name*/) {
  errno = ENOSYS;
  return -1;
}
static int safe_rename_exchange(int /*src_dirfd*/, const char* /*src_name*/,
                                int /*dst_dirfd*/, const char* /*dst_name*/) {
  errno = ENOSYS;
  return -1;
}
#endif

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static napi_value ThrowCode(napi_env env, const char* code, const char* msg) {
  napi_value code_val, msg_val;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_val);
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &msg_val);
  napi_value error;
  napi_create_error(env, code_val, msg_val, &error);
  napi_throw(env, error);
  return nullptr;
}

static napi_value ThrowErrno(napi_env env, const char* syscall, int err,
                              const char* segment) {
  char buf[512];
  snprintf(buf, sizeof(buf), "%s: errno=%d segment=%s", syscall, err, segment);
  return ThrowCode(env, "PATH_UNSAFE", buf);
}

static bool IsSafeSegment(const char* s, size_t len) {
  if (len == 0) return false;
  if (s[0] == '.' && (len == 1 || (len == 2 && s[1] == '.'))) return false;
  for (size_t i = 0; i < len; ++i) {
    if (s[i] == '/' || s[i] == '\0') return false;
  }
  return true;
}

/** Segment validation that allows "." for directory self-query (e.g. readEntry(".")),
 *  but still rejects "..", slashes, and NUL. */
static bool IsSafeSegmentAllowDot(const char* s, size_t len) {
  if (len == 0) return false;
  if (len == 1 && s[0] == '.') return true;  // Allow "."
  if (s[0] == '.' && len == 2 && s[1] == '.') return false;  // Reject ".."
  for (size_t i = 0; i < len; ++i) {
    if (s[i] == '/' || s[i] == '\0') return false;
  }
  return true;
}

/** Close fd without EINTR retry. Per POSIX, close() behavior on EINTR is
 *  undefined — the fd may or may not be closed. Retrying risks closing a
 *  reused fd. CLOEXEC handles cleanup at process exit. */
static int SafeClose(int fd) {
  return ::close(fd);
}

/** UTF-8 extraction with safe NUL-terminated buffer.
 *  Returns false and throws on N-API failure; caller must return immediately. */
static bool GetUtf8(napi_env env, napi_value val, std::string& out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, val, nullptr, 0, &len) != napi_ok) {
    napi_throw_error(env, nullptr, "N-API call failed: napi_get_value_string_utf8");
    return false;
  }
  std::vector<char> buf(len + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, val, buf.data(), len + 1, &written) !=
      napi_ok) {
    napi_throw_error(env, nullptr, "N-API call failed: napi_get_value_string_utf8");
    return false;
  }
  out = std::string(buf.data(), written);
  return true;
}

/** Extract int32 from N-API value.
 *  Returns false and throws on N-API failure; caller must return immediately. */
static bool GetInt32(napi_env env, napi_value val, int32_t& out) {
  if (napi_get_value_int32(env, val, &out) != napi_ok) {
    napi_throw_error(env, nullptr, "N-API call failed: napi_get_value_int32");
    return false;
  }
  return true;
}

static bool GetNamedInt64(napi_env env, napi_value obj, const char* name,
                          int64_t& out) {
  napi_value value;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok) return false;
  return napi_get_value_int64(env, value, &out) == napi_ok;
}

static bool GetNamedDouble(napi_env env, napi_value obj, const char* name,
                           double& out) {
  napi_value value;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok) return false;
  return napi_get_value_double(env, value, &out) == napi_ok;
}

struct ExpectedIdentity {
  int64_t dev;
  int64_t ino;
  int64_t nlink;
  int64_t size;
  int64_t mode;
  double mtime_ns;
  double ctime_ns;
};

static bool GetExpectedIdentity(napi_env env, napi_value value,
                                ExpectedIdentity& expected) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object)
    return false;
  return GetNamedInt64(env, value, "dev", expected.dev) &&
         GetNamedInt64(env, value, "ino", expected.ino) &&
         GetNamedInt64(env, value, "nlink", expected.nlink) &&
         GetNamedInt64(env, value, "size", expected.size) &&
         GetNamedInt64(env, value, "mode", expected.mode) &&
         GetNamedDouble(env, value, "mtimeNs", expected.mtime_ns) &&
         GetNamedDouble(env, value, "ctimeNs", expected.ctime_ns);
}

static bool StatMatchesExpected(const struct stat& st,
                                const ExpectedIdentity& expected) {
  return S_ISREG(st.st_mode) &&
         static_cast<int64_t>(st.st_dev) == expected.dev &&
         static_cast<int64_t>(st.st_ino) == expected.ino &&
         static_cast<int64_t>(st.st_nlink) == expected.nlink &&
         static_cast<int64_t>(st.st_size) == expected.size &&
         static_cast<int64_t>(st.st_mode & 07777) == expected.mode &&
         static_cast<double>(ST_MTIM_NS(st)) == expected.mtime_ns &&
         static_cast<double>(ST_CTIM_NS(st)) == expected.ctime_ns;
}

// A successful directory-entry rename may update ctime even though the file
// content and inode are unchanged. Post-exchange verification therefore keeps
// every stable identity/content field except ctime; mtime still detects an
// in-place content mutation.
static bool StatMatchesExpectedAfterRename(
    const struct stat& st, const ExpectedIdentity& expected) {
  return S_ISREG(st.st_mode) &&
         static_cast<int64_t>(st.st_dev) == expected.dev &&
         static_cast<int64_t>(st.st_ino) == expected.ino &&
         static_cast<int64_t>(st.st_nlink) == expected.nlink &&
         static_cast<int64_t>(st.st_size) == expected.size &&
         static_cast<int64_t>(st.st_mode & 07777) == expected.mode &&
         static_cast<double>(ST_MTIM_NS(st)) == expected.mtime_ns;
}

/** Get the fd from a JS handle object, verifying napi_type_tag.
 *  Returns -1 on failure (invalid handle), without throwing. */
static int GetDirFd(napi_env env, napi_value js_handle_obj) {
  if (!js_handle_obj) return -1;
  napi_valuetype t;
  if (napi_typeof(env, js_handle_obj, &t) != napi_ok) return -1;
  if (t != napi_object) return -1;

  // Verify type tag — rejects objects from other addons or forged objects
  bool tag_ok = false;
  napi_type_tag check_tag = {kDirHandleTag, 0};
  if (napi_check_object_type_tag(env, js_handle_obj, &check_tag, &tag_ok) !=
      napi_ok)
    return -1;
  if (!tag_ok) return -1;

  napi_value ext;
  if (napi_get_named_property(env, js_handle_obj, "_handle", &ext) != napi_ok)
    return -1;
  void* data = nullptr;
  if (napi_get_value_external(env, ext, &data) != napi_ok) return -1;
  if (!data) return -1;
  return *static_cast<int*>(data);
}

// ---------------------------------------------------------------------------
// Segment extraction — argv[idx] must be a safe path segment string
// ---------------------------------------------------------------------------

struct SegmentArg {
  std::string value;
  bool ok;
};

static SegmentArg GetSegment(napi_env env, napi_value* argv, size_t argc,
                              size_t idx, bool allow_dot = false) {
  if (argc <= idx || !argv[idx]) return {"", false};
  napi_valuetype t;
  if (napi_typeof(env, argv[idx], &t) != napi_ok) return {"", false};
  if (t != napi_string) return {"", false};
  std::string s;
  if (!GetUtf8(env, argv[idx], s)) return {"", false};
  if (allow_dot ? !IsSafeSegmentAllowDot(s.c_str(), s.size())
                : !IsSafeSegment(s.c_str(), s.size()))
    return {"", false};
  return {s, true};
}

// ---------------------------------------------------------------------------
// Directory handle — just a bare fd stored as an napi_external.
// The external's destructor closes the fd.
// ---------------------------------------------------------------------------

static void DirFdFinalize(napi_env /*env*/, void* data, void* /*hint*/) {
  if (data) {
    int fd = *static_cast<int*>(data);
    if (fd >= 0) SafeClose(fd);
    delete static_cast<int*>(data);
  }
}

/** Create a JS object wrapping a bare int fd via napi_external.
 *  Tags the object with kDirHandleTag for type verification.
 *  On N-API failure after fd allocation, closes the fd to prevent leaks. */
static napi_value WrapDirFd(napi_env env, int fd) {
  napi_value result, ext;
  if (napi_create_object(env, &result) != napi_ok) {
    SafeClose(fd);
    napi_throw_error(env, nullptr, "N-API call failed: napi_create_object");
    return nullptr;
  }
  int* heap_fd = new (std::nothrow) int(fd);
  if (!heap_fd) {
    SafeClose(fd);
    napi_throw_error(env, nullptr, "allocation failed");
    return nullptr;
  }
  if (napi_create_external(env, heap_fd, DirFdFinalize, nullptr, &ext) !=
      napi_ok) {
    // napi_create_external failed — heap_fd destructor doesn't close fd
    SafeClose(fd);
    delete heap_fd;
    napi_throw_error(env, nullptr, "N-API call failed: napi_create_external");
    return nullptr;
  }
  if (napi_set_named_property(env, result, "_handle", ext) != napi_ok) {
    // ext destructor will call DirFdFinalize which closes fd
    napi_throw_error(env, nullptr, "N-API call failed: napi_set_named_property");
    return nullptr;
  }
  // Tag the object so only our addon's handles pass type check
  napi_type_tag tag = {kDirHandleTag, 0};
  if (napi_type_tag_object(env, result, &tag) != napi_ok) {
    napi_throw_error(env, nullptr, "N-API call failed: napi_type_tag_object");
    return nullptr;
  }
  return result;
}

// ---------------------------------------------------------------------------
// TempToken — identity-bound safe temp file token
// ---------------------------------------------------------------------------

struct TempToken {
  int tmp_fd;
  int dir_fd;
  dev_t tmp_dev;
  ino_t tmp_ino;
  char name[PATH_MAX];
  bool active;
  bool committed;

  TempToken()
      : tmp_fd(-1), dir_fd(-1), tmp_dev(0), tmp_ino(0), active(true),
        committed(false) {
    name[0] = '\0';
  }

  ~TempToken() { CloseFds(); }

  void CloseFds() {
    if (tmp_fd >= 0) {
      SafeClose(tmp_fd);
      tmp_fd = -1;
    }
    if (dir_fd >= 0) {
      SafeClose(dir_fd);
      dir_fd = -1;
    }
  }

  TempToken(const TempToken&) = delete;
  TempToken& operator=(const TempToken&) = delete;
};

// Forward declarations — defined in the identity-bound cleanup section below.
static bool identity_unlink(TempToken* tok);
static void cleanup_temp(TempToken* tok);

static void TempTokenFinalize(napi_env /*env*/, void* data, void* /*hint*/) {
  TempToken* tok = static_cast<TempToken*>(data);
  if (tok) {
    // Identity-bound cleanup: only unlink if the token is still active
    // (not consumed by rename/abortTemp or already cleaned up by a
    // CreateTemp N-API failure path).
    if (tok->active && !tok->committed) {
      identity_unlink(tok);
    }
    delete tok;
  }
}

/** Unwrap a TempToken from a JS object, verifying napi_type_tag.
 *  Returns nullptr if the object is not a genuine token from this addon.
 *  On N-API failure, returns nullptr (caller must check). */
static TempToken* GetTempToken(napi_env env, napi_value js_obj) {
  if (!js_obj) return nullptr;
  napi_valuetype t;
  if (napi_typeof(env, js_obj, &t) != napi_ok) return nullptr;
  if (t != napi_object) return nullptr;

  // Verify type tag
  bool tag_ok = false;
  napi_type_tag check_tag = {kTempTokenTag, 0};
  if (napi_check_object_type_tag(env, js_obj, &check_tag, &tag_ok) != napi_ok)
    return nullptr;
  if (!tag_ok) return nullptr;

  napi_value tok_ext;
  if (napi_get_named_property(env, js_obj, "_token", &tok_ext) != napi_ok)
    return nullptr;
  void* tok_data = nullptr;
  if (napi_get_value_external(env, tok_ext, &tok_data) != napi_ok)
    return nullptr;
  return static_cast<TempToken*>(tok_data);
}

// ---------------------------------------------------------------------------
// openRoot(path) -> { _handle }
//
// Walks from "/" one segment at a time with openat(O_DIRECTORY|O_NOFOLLOW|
// O_CLOEXEC). Rejects non-absolute paths, ancestor symlinks, ".", "..",
// and NUL bytes.
// ---------------------------------------------------------------------------

static napi_value OpenRoot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (argc < 1)
    return ThrowCode(env, "PATH_UNSAFE", "openRoot requires a path");

  napi_valuetype t;
  NAPI_CHECK(napi_typeof(env, argv[0], &t));
  if (t != napi_string)
    return ThrowCode(env, "PATH_UNSAFE", "openRoot path must be a string");

  std::string path;
  if (!GetUtf8(env, argv[0], path))
    return nullptr;

  if (path.empty() || path[0] != '/') {
    return ThrowCode(env, "PATH_UNSAFE", "openRoot requires absolute path");
  }

  int cur_fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (cur_fd < 0) {
    return ThrowErrno(env, "open", errno, "/");
  }

  size_t pos = 1;
  while (pos < path.size()) {
    size_t next = path.find('/', pos);
    if (next == std::string::npos) next = path.size();

    std::string seg = path.substr(pos, next - pos);
    pos = next + 1;

    if (seg.empty()) continue;

    if (!IsSafeSegment(seg.c_str(), seg.size())) {
      SafeClose(cur_fd);
      return ThrowErrno(env, "openat", EINVAL, seg.c_str());
    }

    int child_fd = openat(cur_fd, seg.c_str(),
                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved_errno = errno;
    SafeClose(cur_fd);

    if (child_fd < 0) {
      return ThrowErrno(env, "openat", saved_errno, seg.c_str());
    }
    cur_fd = child_fd;
  }

  return WrapDirFd(env, cur_fd);
}

// ---------------------------------------------------------------------------
// openDir(handle, name) -> { _handle }
// ---------------------------------------------------------------------------

static napi_value OpenDir(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int parent_fd = GetDirFd(env, argv[0]);
  if (parent_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "openDir: unsafe segment");

  int child_fd = openat(parent_fd, seg.value.c_str(),
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (child_fd < 0)
    return ThrowErrno(env, "openat", errno, seg.value.c_str());

  return WrapDirFd(env, child_fd);
}

// ---------------------------------------------------------------------------
// readEntry(handle, name) -> { type, size, mode, dev, ino, nlink } | null
// ---------------------------------------------------------------------------

static napi_value ReadEntry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  // Allow "." for directory self-query (e.g. readEntry(".") to inspect own metadata)
  auto seg = GetSegment(env, argv, argc, 1, /*allow_dot=*/true);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "readEntry: unsafe segment");

  struct stat st;
  // For "." use fstat on the directory fd itself (not fstatat on ".")
  if (seg.value == ".") {
    if (fstat(dir_fd, &st) < 0) {
      return ThrowErrno(env, "fstat", errno, ".");
    }
  } else {
    if (fstatat(dir_fd, seg.value.c_str(), &st, AT_SYMLINK_NOFOLLOW) < 0) {
      if (errno == ENOENT) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
      }
      return ThrowErrno(env, "fstatat", errno, seg.value.c_str());
    }
  }

  napi_value result;
  NAPI_CHECK(napi_create_object(env, &result));

  const char* type = "unknown";
  if (S_ISREG(st.st_mode)) type = "file";
  else if (S_ISDIR(st.st_mode)) type = "directory";
  else if (S_ISLNK(st.st_mode)) type = "symlink";
  else if (S_ISFIFO(st.st_mode)) type = "fifo";
  else if (S_ISBLK(st.st_mode)) type = "block-device";
  else if (S_ISCHR(st.st_mode)) type = "char-device";
  else if (S_ISSOCK(st.st_mode)) type = "socket";

  napi_value type_val, size_val, mode_val, dev_val, ino_val, nlink_val;
  NAPI_CHECK(napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &type_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(st.st_size), &size_val));
  NAPI_CHECK(
      napi_create_int32(env, static_cast<int32_t>(st.st_mode & 07777),
                        &mode_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(st.st_dev), &dev_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(st.st_ino), &ino_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(st.st_nlink), &nlink_val));

  NAPI_CHECK(napi_set_named_property(env, result, "type", type_val));
  NAPI_CHECK(napi_set_named_property(env, result, "size", size_val));
  NAPI_CHECK(napi_set_named_property(env, result, "mode", mode_val));
  NAPI_CHECK(napi_set_named_property(env, result, "dev", dev_val));
  NAPI_CHECK(napi_set_named_property(env, result, "ino", ino_val));
  NAPI_CHECK(napi_set_named_property(env, result, "nlink", nlink_val));
  return result;
}

// ---------------------------------------------------------------------------
// readFile(handle, name) -> { bytes: Buffer, size, mode, dev, ino, nlink }
//
// Opens with O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC to prevent FIFO
// blocking. Validates via fstat on the opened fd (regular, nlink=1),
// reads all bytes, then performs post-read identity verification.
// ---------------------------------------------------------------------------

static napi_value ReadFile(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "readFile: unsafe segment");

  // Open with O_NONBLOCK to prevent blocking on FIFOs (security: B1).
  // O_NOFOLLOW rejects symlinks at open time.
  int file_fd = openat(dir_fd, seg.value.c_str(),
                       O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    if (errno == ENOENT) {
      napi_value null_val;
      napi_get_null(env, &null_val);
      return null_val;
    }
    return ThrowErrno(env, "openat", errno, seg.value.c_str());
  }

  // Validate via fstat on the opened fd
  struct stat st;
  if (fstat(file_fd, &st) < 0) {
    int saved = errno;
    SafeClose(file_fd);
    return ThrowErrno(env, "fstat", saved, seg.value.c_str());
  }

  if (!S_ISREG(st.st_mode)) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE", "readFile: not a regular file");
  }

  if (st.st_nlink != 1) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE",
                     "readFile: unexpected hard link count");
  }

  // Read all bytes — always loop (even from size=0) to handle concurrent
  // growth, partial reads, and EINTR. Documented capacity limit: 256 MiB.
  constexpr size_t kMaxReadCapacity = 256ULL * 1024 * 1024;  // 256 MiB
  std::vector<uint8_t> buf;
  {
    size_t init_size = (st.st_size > 0)
                           ? static_cast<size_t>(st.st_size)
                           : 65536;
    if (init_size > kMaxReadCapacity) init_size = kMaxReadCapacity;
    buf.resize(init_size);
    size_t total = 0;
    while (true) {
      size_t want = buf.size() - total;
      if (want == 0) {
        // Buffer full — check capacity before growing
        if (buf.size() >= kMaxReadCapacity) {
          SafeClose(file_fd);
          return ThrowCode(env, "PATH_UNSAFE",
                           "readFile: capacity limit exceeded (256 MiB)");
        }
        size_t new_cap = buf.size() + 65536;
        if (new_cap > kMaxReadCapacity) new_cap = kMaxReadCapacity;
        buf.resize(new_cap);
        want = buf.size() - total;
      }
      ssize_t n = ::read(file_fd, buf.data() + total, want);
      if (n < 0) {
        if (errno == EINTR) continue;
        int saved = errno;
        SafeClose(file_fd);
        return ThrowErrno(env, "read", saved, seg.value.c_str());
      }
      if (n == 0) break;
      total += static_cast<size_t>(n);
    }
    buf.resize(total);
  }

  // Post-read identity verification (B3): check that the file hasn't been
  // concurrently replaced or modified. Compare dev/ino/type/nlink/size/mtime/ctime.
  struct stat post_st;
  if (fstat(file_fd, &post_st) < 0) {
    int saved = errno;
    SafeClose(file_fd);
    return ThrowErrno(env, "fstat", saved, seg.value.c_str());
  }
  if (post_st.st_dev != st.st_dev || post_st.st_ino != st.st_ino ||
      !S_ISREG(post_st.st_mode) || post_st.st_nlink != st.st_nlink) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE",
                     "readFile: file identity changed during read");
  }
  if (static_cast<size_t>(post_st.st_size) != buf.size()) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE",
                     "readFile: file size changed during read");
  }
  // Compare mtime and ctime (with nanosecond precision on supported platforms)
  if (ST_MTIM_NS(post_st) != ST_MTIM_NS(st) ||
      ST_CTIM_NS(post_st) != ST_CTIM_NS(st)) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE",
                     "readFile: file timestamp changed during read");
  }

  SafeClose(file_fd);

  // Build result
  napi_value result;
  NAPI_CHECK(napi_create_object(env, &result));

  napi_value bytes_val;
  void* copy_data = nullptr;
  NAPI_CHECK(napi_create_buffer_copy(env, buf.size(), buf.data(), &copy_data,
                                     &bytes_val));
  (void)copy_data;

  napi_value size_val, mode_val, dev_val, ino_val, nlink_val, mtime_val, ctime_val;
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(post_st.st_size), &size_val));
  NAPI_CHECK(
      napi_create_int32(env, static_cast<int32_t>(post_st.st_mode & 07777),
                        &mode_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(post_st.st_dev), &dev_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(post_st.st_ino), &ino_val));
  NAPI_CHECK(
      napi_create_int64(env, static_cast<int64_t>(post_st.st_nlink),
                        &nlink_val));
  NAPI_CHECK(
      napi_create_double(env, static_cast<double>(ST_MTIM_NS(post_st)),
                         &mtime_val));
  NAPI_CHECK(
      napi_create_double(env, static_cast<double>(ST_CTIM_NS(post_st)),
                         &ctime_val));

  NAPI_CHECK(napi_set_named_property(env, result, "bytes", bytes_val));
  NAPI_CHECK(napi_set_named_property(env, result, "size", size_val));
  NAPI_CHECK(napi_set_named_property(env, result, "mode", mode_val));
  NAPI_CHECK(napi_set_named_property(env, result, "dev", dev_val));
  NAPI_CHECK(napi_set_named_property(env, result, "ino", ino_val));
  NAPI_CHECK(napi_set_named_property(env, result, "nlink", nlink_val));
  NAPI_CHECK(napi_set_named_property(env, result, "mtimeNs", mtime_val));
  NAPI_CHECK(napi_set_named_property(env, result, "ctimeNs", ctime_val));

  return result;
}

// ---------------------------------------------------------------------------
// Identity-bound temp cleanup.
//
// Single cleanup path shared by all CreateTemp N-API failure branches and
// the TempTokenFinalize.
//
// identity_unlink(tok) — two-phase identity check:
//   1) fstat(tok->tmp_fd) on the open fd
//   2) fstatat(tok->dir_fd, tok->name) on the directory entry
//   3) Both must match each other AND creation-time dev/ino, be S_ISREG,
//      and have nlink==1 before unlinking.
// On success, marks tok->active = false.
//
// Before napi_create_external: the caller owns tok and must delete it.
//   Use cleanup_temp(tok) — identity-bound unlink, close fds, delete.
// After napi_create_external:  tok is owned by the finalizer; use
//   identity_unlink(tok) — identity-bound unlink only, do NOT close fds
//   or delete (the finalizer handles that).
// ---------------------------------------------------------------------------

/** Identity-bound unlink: two-phase check (fd + directory entry) against
 *  creation-time identity before unlinking. Returns true if the file was
 *  unlinked, false if identity didn't match or unlink failed. */
static bool identity_unlink(TempToken* tok) {
  if (!tok || tok->dir_fd < 0 || tok->name[0] == '\0') return false;
  // Phase 1: fstat the open fd
  struct stat fd_st;
  if (fstat(tok->tmp_fd, &fd_st) < 0) return false;
  if (!S_ISREG(fd_st.st_mode) || fd_st.st_nlink != 1) return false;
  if (fd_st.st_dev != tok->tmp_dev || fd_st.st_ino != tok->tmp_ino)
    return false;
  // Phase 2: fstatat the directory entry
  struct stat dir_st;
  if (fstatat(tok->dir_fd, tok->name, &dir_st, AT_SYMLINK_NOFOLLOW) < 0)
    return false;
  if (!S_ISREG(dir_st.st_mode) || dir_st.st_nlink != 1) return false;
  if (dir_st.st_dev != tok->tmp_dev || dir_st.st_ino != tok->tmp_ino)
    return false;
  // Both phases passed — unlink
  if (unlinkat(tok->dir_fd, tok->name, 0) == 0) {
    tok->active = false;
    return true;
  }
  return false;
}

/** Identity-bound unlink, close+delete the token (caller owns tok). */
static void cleanup_temp(TempToken* tok) {
  if (!tok) return;
  identity_unlink(tok);
  tok->CloseFds();
  delete tok;
}

// ---------------------------------------------------------------------------
// createTemp(handle, name, mode, Buffer) -> { tempName, _token }
//
// Validates: name is safe segment, mode is 0..0777, data is Buffer.
// Creates temp file, writes data, fsyncs, applies fchmod for exact mode,
// captures identity, and returns a type-tagged TempToken.
// ---------------------------------------------------------------------------

static napi_value CreateTemp(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  if (argc < 4)
    return ThrowCode(env, "PATH_UNSAFE",
                     "createTemp requires name, mode, and data");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "createTemp: unsafe name segment");

  // Validate mode type (must be int32) before extracting value (A2)
  {
    napi_valuetype mt;
    NAPI_CHECK(napi_typeof(env, argv[2], &mt));
    if (mt != napi_number) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "createTemp: mode must be a number");
    }
    // Reject NaN and non-integer doubles (e.g. 644.5, Infinity)
    double dval = 0;
    NAPI_CHECK(napi_get_value_double(env, argv[2], &dval));
    if (dval != dval || dval == INFINITY) {  // NaN check via self-inequality
      return ThrowCode(env, "PATH_UNSAFE",
                       "createTemp: mode must be an integer");
    }
    if (static_cast<double>(static_cast<int32_t>(dval)) != dval) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "createTemp: mode must be an integer");
    }
  }

  // Validate mode range (A2)
  int32_t mode = 0;
  if (!GetInt32(env, argv[2], mode))
    return nullptr;
  if (mode < 0 || mode > 0777) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "createTemp: mode must be 0..0777");
  }

  // Require Buffer data — empty Buffer is legal, but must be a Buffer (A2)
  if (!argv[3]) {
    return ThrowCode(env, "PATH_UNSAFE", "createTemp: data must be a Buffer");
  }
  {
    napi_valuetype dt;
    NAPI_CHECK(napi_typeof(env, argv[3], &dt));
    if (dt != napi_object) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "createTemp: data must be a Buffer");
    }
    bool is_buf = false;
    NAPI_CHECK(napi_is_buffer(env, argv[3], &is_buf));
    if (!is_buf) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "createTemp: data must be a Buffer");
    }
  }

  const uint8_t* data = nullptr;
  size_t data_len = 0;
  NAPI_CHECK(napi_get_buffer_info(env, argv[3], (void**)&data, &data_len));

  // Generate temp name
  uint64_t r = 0;
#if defined(__APPLE__) || defined(__FreeBSD__)
  r = (static_cast<uint64_t>(arc4random()) << 32) | arc4random();
#else
  r = (static_cast<uint64_t>(random()) << 32) | random();
#endif
  char tmp_name[PATH_MAX];
  int name_len = snprintf(tmp_name, sizeof(tmp_name), ".tmp-%s-%d-%llx",
                          seg.value.c_str(), static_cast<int>(getpid()),
                          static_cast<unsigned long long>(r));
  if (name_len < 0 ||
      static_cast<size_t>(name_len) >= sizeof(tmp_name)) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "createTemp: temp name truncated");
  }

  int tmp_fd = openat(dir_fd, tmp_name,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                      mode);
  if (tmp_fd < 0) return ThrowErrno(env, "openat", errno, tmp_name);

  // Write data in a loop (handles partial writes and EINTR)
  if (data_len > 0) {
    size_t written = 0;
    while (written < data_len) {
      ssize_t n = ::write(tmp_fd, data + written, data_len - written);
      if (n < 0) {
        if (errno == EINTR) continue;
        int saved = errno;
        SafeClose(tmp_fd);
        unlinkat(dir_fd, tmp_name, 0);
        return ThrowErrno(env, "write", saved, tmp_name);
      }
      if (n == 0) {
        SafeClose(tmp_fd);
        unlinkat(dir_fd, tmp_name, 0);
        return ThrowErrno(env, "write", EIO, tmp_name);
      }
      written += static_cast<size_t>(n);
    }
  }

  // Apply exact mode via fchmod on the fd BEFORE fsync (A2).
  // This ensures the mode is persisted with the data.
  if (fchmod(tmp_fd, mode) < 0) {
    int saved = errno;
    SafeClose(tmp_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowErrno(env, "fchmod", saved, tmp_name);
  }

  // fsync data AND mode to disk before identity capture
  if (fsync(tmp_fd) < 0) {
    int saved = errno;
    SafeClose(tmp_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowErrno(env, "fsync", saved, tmp_name);
  }

  // Capture identity of the temp file via fstat on the open fd
  struct stat tmp_st;
  if (fstat(tmp_fd, &tmp_st) < 0) {
    int saved = errno;
    SafeClose(tmp_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowErrno(env, "fstat", saved, tmp_name);
  }
  if (!S_ISREG(tmp_st.st_mode) || tmp_st.st_nlink != 1) {
    SafeClose(tmp_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowCode(env, "PATH_UNSAFE", "createTemp: identity check failed");
  }

  // dup the directory fd with CLOEXEC (A5)
  int token_dir_fd = fcntl(dir_fd, F_DUPFD_CLOEXEC, 0);
  if (token_dir_fd < 0) {
    int saved = errno;
    SafeClose(tmp_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowErrno(env, "fcntl(F_DUPFD_CLOEXEC)", saved, "<dir>");
  }

  // Build the TempToken
  TempToken* tok = new (std::nothrow) TempToken();
  if (!tok) {
    SafeClose(tmp_fd);
    SafeClose(token_dir_fd);
    unlinkat(dir_fd, tmp_name, 0);
    return ThrowCode(env, "PATH_UNSAFE", "createTemp: allocation failed");
  }
  tok->tmp_fd = tmp_fd;
  tok->dir_fd = token_dir_fd;
  tok->tmp_dev = tmp_st.st_dev;
  tok->tmp_ino = tmp_st.st_ino;
  tok->active = true;
  tok->committed = false;
  strncpy(tok->name, tmp_name, PATH_MAX - 1);
  tok->name[PATH_MAX - 1] = '\0';

  // Build return object: { tempName, _token }
  // On any N-API failure, unlink the temp file before closing fds to prevent
  // orphan temp files. cleanup_temp(tok) performs identity-bound unlink
  // then closes fds and deletes the token.
  //
  // Test seam points fire BEFORE the real N-API call. When a seam fires,
  // it throws PATH_UNSAFE (stable error code) and returns immediately,
  // skipping the real N-API call. This ensures deterministic testing:
  // the file stays on disk (no real unlinkat) and the error has a stable code.
  napi_value result;
#ifdef SAFE_WRITE_TEST_SEAM
  if (TestSeamShouldFail(kSeamCreateObject)) {
    cleanup_temp(tok);
    return ThrowCode(env, "PATH_UNSAFE", "test seam: createTemp create_object");
  }
#endif
  if (napi_create_object(env, &result) != napi_ok) {
    cleanup_temp(tok);
    napi_throw_error(env, nullptr, "N-API call failed: napi_create_object");
    return nullptr;
  }

  napi_value name_val;
#ifdef SAFE_WRITE_TEST_SEAM
  if (TestSeamShouldFail(kSeamCreateString)) {
    cleanup_temp(tok);
    return ThrowCode(env, "PATH_UNSAFE", "test seam: createTemp create_string");
  }
#endif
  if (napi_create_string_utf8(env, tmp_name, NAPI_AUTO_LENGTH, &name_val) !=
      napi_ok) {
    cleanup_temp(tok);
    napi_throw_error(env, nullptr,
                     "N-API call failed: napi_create_string_utf8");
    return nullptr;
  }

  napi_value ext;
#ifdef SAFE_WRITE_TEST_SEAM
  if (TestSeamShouldFail(kSeamCreateExternal)) {
    cleanup_temp(tok);
    return ThrowCode(env, "PATH_UNSAFE", "test seam: createTemp create_external");
  }
#endif
  if (napi_create_external(env, tok, TempTokenFinalize, nullptr, &ext) !=
      napi_ok) {
    cleanup_temp(tok);
    napi_throw_error(env, nullptr, "N-API call failed: napi_create_external");
    return nullptr;
  }

  // After napi_create_external succeeded, tok is owned by the finalizer.
  // We must NOT delete tok or close fds — use identity_unlink(tok) for
  // identity-bound unlink + mark inactive.
#ifdef SAFE_WRITE_TEST_SEAM
  if (TestSeamShouldFail(kSeamSetProperty)) {
    identity_unlink(tok);
    return ThrowCode(env, "PATH_UNSAFE", "test seam: createTemp set_property");
  }
#endif
  if (napi_set_named_property(env, result, "tempName", name_val) != napi_ok ||
      napi_set_named_property(env, result, "_token", ext) != napi_ok) {
    identity_unlink(tok);
    napi_throw_error(env, nullptr,
                     "N-API call failed: napi_set_named_property");
    return nullptr;
  }

  // Tag the token object (A3)
  napi_type_tag tok_tag = {kTempTokenTag, 0};
#ifdef SAFE_WRITE_TEST_SEAM
  if (TestSeamShouldFail(kSeamTypeTag)) {
    identity_unlink(tok);
    return ThrowCode(env, "PATH_UNSAFE", "test seam: createTemp type_tag");
  }
#endif
  if (napi_type_tag_object(env, result, &tok_tag) != napi_ok) {
    identity_unlink(tok);
    napi_throw_error(env, nullptr, "N-API call failed: napi_type_tag_object");
    return nullptr;
  }

  return result;
}

// ---------------------------------------------------------------------------
// rename(handle, token, targetSegment)
// ---------------------------------------------------------------------------

static napi_value Rename(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  if (argc < 3)
    return ThrowCode(env, "PATH_UNSAFE", "rename requires token and target");

  // Unwrap token with type tag verification (A3)
  TempToken* tok = GetTempToken(env, argv[1]);
  if (!tok)
    return ThrowCode(env, "PATH_UNSAFE", "rename: invalid token");

  if (!tok->active)
    return ThrowCode(env, "PATH_UNSAFE", "rename: token already consumed");
  if (tok->committed)
    return ThrowCode(env, "PATH_UNSAFE", "rename: token already committed");

  auto to_seg = GetSegment(env, argv, argc, 2);
  if (!to_seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "rename: unsafe target segment");

  // 1. Verify directory identity
  if (tok->dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "rename: token directory fd invalid");

  struct stat caller_dir_st, token_dir_st;
  if (fstat(dir_fd, &caller_dir_st) < 0)
    return ThrowErrno(env, "fstat", errno, "<dir>");
  if (fstat(tok->dir_fd, &token_dir_st) < 0)
    return ThrowErrno(env, "fstat", errno, "<token-dir>");

  if (caller_dir_st.st_dev != token_dir_st.st_dev ||
      caller_dir_st.st_ino != token_dir_st.st_ino) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: token directory identity mismatch");
  }

  // 2. Verify temp file identity — TWO-PHASE THREE-PARTY CHECK (RED 8):
  //    a) fstat(tok->tmp_fd) — the open fd (attack-resistant)
  //    b) fstatat(tok->dir_fd, tok->name) — the directory entry by name
  //    c) Both must match each other AND the creation-time identity
  struct stat tmp_fd_st;
  if (fstat(tok->tmp_fd, &tmp_fd_st) < 0) {
    return ThrowErrno(env, "fstat", errno, "<tmp_fd>");
  }
  struct stat tmp_st;
  if (fstatat(tok->dir_fd, tok->name, &tmp_st, AT_SYMLINK_NOFOLLOW) < 0) {
    return ThrowErrno(env, "fstatat", errno, tok->name);
  }
  // fd and name must point to the same file
  if (tmp_fd_st.st_dev != tmp_st.st_dev ||
      tmp_fd_st.st_ino != tmp_st.st_ino) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: temp fd/name identity mismatch");
  }
  if (!S_ISREG(tmp_fd_st.st_mode))
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: temp is no longer a regular file");
  if (tmp_fd_st.st_nlink != 1)
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: temp has unexpected hard link count");
  if (tmp_fd_st.st_dev != tok->tmp_dev ||
      tmp_fd_st.st_ino != tok->tmp_ino) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: temp identity mismatch (dev/ino changed)");
  }

  // 3. Commit. With an expected identity object, atomically exchange the
  // temp and existing target, prove that the displaced entry is the exact
  // entry read by the caller, then unlink it. Without expected identity the
  // operation remains strict no-replace creation.
  bool replacing = argc >= 4;
  int old_fd = -1;
  if (replacing) {
    ExpectedIdentity expected;
    if (!GetExpectedIdentity(env, argv[3], expected)) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "rename: invalid expected identity token");
    }
    old_fd = openat(dir_fd, to_seg.value.c_str(),
                    O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (old_fd < 0)
      return ThrowErrno(env, "openat", errno, to_seg.value.c_str());

    struct stat old_fd_st, old_name_st;
    if (fstat(old_fd, &old_fd_st) < 0 ||
        fstatat(dir_fd, to_seg.value.c_str(), &old_name_st,
                AT_SYMLINK_NOFOLLOW) < 0) {
      int saved = errno;
      SafeClose(old_fd);
      return ThrowErrno(env, "fstat", saved, to_seg.value.c_str());
    }
    if (!StatMatchesExpected(old_fd_st, expected) ||
        old_fd_st.st_dev != old_name_st.st_dev ||
        old_fd_st.st_ino != old_name_st.st_ino ||
        !StatMatchesExpected(old_name_st, expected)) {
      SafeClose(old_fd);
      return ThrowCode(env, "PATH_UNSAFE",
                       "rename: expected target identity changed");
    }

    if (safe_rename_exchange(tok->dir_fd, tok->name, dir_fd,
                             to_seg.value.c_str()) < 0) {
      int saved = errno;
      SafeClose(old_fd);
      if (saved == ENOSYS) {
        return ThrowCode(env, "SAFE_WRITE_UNAVAILABLE",
                         "atomic exchange rename not supported on platform");
      }
      return ThrowErrno(env, "renameat_exchange", saved,
                        to_seg.value.c_str());
    }

    struct stat displaced_st, old_post_st, new_target_st;
    bool exchange_valid =
        fstatat(tok->dir_fd, tok->name, &displaced_st,
                AT_SYMLINK_NOFOLLOW) == 0 &&
        fstat(old_fd, &old_post_st) == 0 &&
        fstatat(dir_fd, to_seg.value.c_str(), &new_target_st,
                AT_SYMLINK_NOFOLLOW) == 0 &&
        displaced_st.st_dev == old_post_st.st_dev &&
        displaced_st.st_ino == old_post_st.st_ino &&
        StatMatchesExpectedAfterRename(old_post_st, expected) &&
        StatMatchesExpectedAfterRename(displaced_st, expected) &&
        new_target_st.st_dev == tok->tmp_dev &&
        new_target_st.st_ino == tok->tmp_ino &&
        S_ISREG(new_target_st.st_mode) && new_target_st.st_nlink == 1;

    if (!exchange_valid) {
      int rollback_rc = safe_rename_exchange(tok->dir_fd, tok->name, dir_fd,
                                             to_seg.value.c_str());
      SafeClose(old_fd);
      if (rollback_rc < 0) {
        tok->active = false;
        tok->committed = true;
        SafeClose(tok->tmp_fd);
        tok->tmp_fd = -1;
        SafeClose(tok->dir_fd);
        tok->dir_fd = -1;
        return ThrowCode(env, "PATH_UNSAFE",
                         "rename: exchange verification and rollback failed");
      }
      return ThrowCode(env, "PATH_UNSAFE",
                       "rename: expected target changed during exchange");
    }

    if (unlinkat(tok->dir_fd, tok->name, 0) < 0) {
      int saved = errno;
      SafeClose(old_fd);
      tok->active = false;
      tok->committed = true;
      SafeClose(tok->tmp_fd);
      tok->tmp_fd = -1;
      SafeClose(tok->dir_fd);
      tok->dir_fd = -1;
      return ThrowErrno(env, "unlinkat", saved, tok->name);
    }
    SafeClose(old_fd);
  } else {
    int rc = safe_rename_noreplace(tok->dir_fd, tok->name, dir_fd,
                                   to_seg.value.c_str());
    if (rc < 0) {
      int saved = errno;
      if (saved == EEXIST || saved == ENOTEMPTY) {
        return ThrowCode(env, "PATH_UNSAFE", "rename target already exists");
      }
      if (saved == ENOSYS) {
        return ThrowCode(env, "SAFE_WRITE_UNAVAILABLE",
                         "atomic no-replace rename not supported on platform");
      }
      return ThrowErrno(env, "renameat_noreplace", saved,
                        to_seg.value.c_str());
    }
  }

  // 4. Verify target identity matches token (B3).
  //    After rename, target must match the still-open token fd (attack-resistant).
  //    Mark committed immediately after rename succeeds (RED 8: rename once
  //    successful is immediately marked committed/consumed).
  tok->active = false;
  tok->committed = true;

  struct stat target_st;
  if (fstatat(dir_fd, to_seg.value.c_str(), &target_st,
             AT_SYMLINK_NOFOLLOW) < 0) {
    // Rename succeeded but can't verify target by name — uncertain durability.
    // Token already marked committed; close fds.
    int saved = errno;
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowErrno(env, "fstatat", saved, to_seg.value.c_str());
  }

  // Cross-check with the still-open token fd
  struct stat post_fd_st;
  if (fstat(tok->tmp_fd, &post_fd_st) < 0) {
    int saved = errno;
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowErrno(env, "fstat", saved, "<tmp_fd>");
  }

  // Verify target, token fd, and creation identity all match
  if (target_st.st_dev != tok->tmp_dev ||
      target_st.st_ino != tok->tmp_ino) {
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: target identity mismatch");
  }
  if (post_fd_st.st_dev != tok->tmp_dev ||
      post_fd_st.st_ino != tok->tmp_ino) {
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: token fd identity changed after rename");
  }
  if (!S_ISREG(target_st.st_mode) || target_st.st_nlink != 1) {
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowCode(env, "PATH_UNSAFE",
                     "rename: target is not regular or nlink!=1");
  }

  // 5. Fsync directory
  int fsync_rc;
  do {
    fsync_rc = fsync(dir_fd);
  } while (fsync_rc < 0 && errno == EINTR);
  if (fsync_rc < 0) {
    int saved = errno;
    // Target exists and identity verified, but directory not synced.
    // Mark committed since rename is durable on most filesystems.
    tok->active = false;
    tok->committed = true;
    SafeClose(tok->tmp_fd);
    tok->tmp_fd = -1;
    SafeClose(tok->dir_fd);
    tok->dir_fd = -1;
    return ThrowErrno(env, "fsync", saved, "<dir>");
  }

  // 6. Consume token
  tok->active = false;
  tok->committed = true;
  SafeClose(tok->tmp_fd);
  tok->tmp_fd = -1;
  SafeClose(tok->dir_fd);
  tok->dir_fd = -1;

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// abortTemp(handle, token)
// ---------------------------------------------------------------------------

static napi_value AbortTemp(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  if (argc < 2)
    return ThrowCode(env, "PATH_UNSAFE", "abortTemp requires token");

  // Unwrap token with type tag verification (A3)
  TempToken* tok = GetTempToken(env, argv[1]);
  if (!tok)
    return ThrowCode(env, "PATH_UNSAFE", "abortTemp: invalid token");

  if (!tok->active) {
    return ThrowCode(env, "PATH_UNSAFE", "abortTemp: token already consumed");
  }

  // Verify caller directory matches token directory (cross-directory abort)
  if (tok->dir_fd >= 0) {
    struct stat caller_dir_st, token_dir_st;
    if (fstat(dir_fd, &caller_dir_st) < 0)
      return ThrowErrno(env, "fstat", errno, "<dir>");
    if (fstat(tok->dir_fd, &token_dir_st) < 0)
      return ThrowErrno(env, "fstat", errno, "<token-dir>");
    if (caller_dir_st.st_dev != token_dir_st.st_dev ||
        caller_dir_st.st_ino != token_dir_st.st_ino) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "abortTemp: directory identity mismatch");
    }
  }

  // Determine result before consuming token.
  // Returns {removed: boolean, reason: string} per frozen contract.
  bool removed = false;
  const char* reason = "unknown";

  if (tok->committed) {
    removed = false;
    reason = "already_committed";
  } else if (tok->dir_fd < 0 || tok->name[0] == '\0') {
    removed = false;
    reason = "identity_missing";
  } else {
    struct stat st;
    if (fstatat(tok->dir_fd, tok->name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      removed = false;
      reason = "missing";
    } else if (!S_ISREG(st.st_mode) || st.st_dev != tok->tmp_dev ||
               st.st_ino != tok->tmp_ino) {
      removed = false;
      reason = "identity_mismatch";
    } else if (st.st_nlink != 1) {
      removed = false;
      reason = "nlink_gt_1";
    } else {
      // Identity matches and nlink==1 — attempt unlink.
      // If unlink fails, this is a fatal error: the temp file exists with
      // matching identity but cannot be removed. Throw an error rather than
      // silently returning removed=false.
      bool unlink_ok = false;
#ifdef SAFE_WRITE_TEST_SEAM
      if (TestSeamShouldFail(kSeamAbortUnlink)) {
        // Simulate EACCES from unlinkat
        errno = EACCES;
      } else if (unlinkat(tok->dir_fd, tok->name, 0) == 0) {
        unlink_ok = true;
      }
#else
      if (unlinkat(tok->dir_fd, tok->name, 0) == 0) {
        unlink_ok = true;
      }
#endif
      if (unlink_ok) {
        removed = true;
        reason = "removed";
      } else {
        // Do NOT consume the token — throw without closing fds or marking
        // inactive. The caller may reset the seam and retry with the same
        // token. The temp file remains on disk (identity verified).
        return ThrowErrno(env, "unlinkat", errno, tok->name);
      }
    }
  }

  // Consume token (close fds)
  tok->active = false;
  SafeClose(tok->tmp_fd);
  tok->tmp_fd = -1;
  SafeClose(tok->dir_fd);
  tok->dir_fd = -1;

  // Build return object: { removed, reason }
  napi_value result;
  NAPI_CHECK(napi_create_object(env, &result));

  napi_value removed_val, reason_val;
  NAPI_CHECK(napi_get_boolean(env, removed, &removed_val));
  NAPI_CHECK(napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &reason_val));
  NAPI_CHECK(napi_set_named_property(env, result, "removed", removed_val));
  NAPI_CHECK(napi_set_named_property(env, result, "reason", reason_val));
  return result;
}

// ---------------------------------------------------------------------------
// mkdir(handle, name, mode) — fd-relative via mkdirat (exclusive)
//
// Creates a directory with the given name and mode inside the parent handle.
// Exclusive: EEXIST if the entry already exists (no overwrite).
// mkdirat does not follow symlinks by design (POSIX).
// After success, fsync the parent directory for durability.
// ---------------------------------------------------------------------------

static napi_value Mkdir(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  if (argc < 3)
    return ThrowCode(env, "PATH_UNSAFE", "mkdir requires name and mode");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "mkdir: unsafe segment");

  // Validate mode type (must be int32)
  {
    napi_valuetype mt;
    NAPI_CHECK(napi_typeof(env, argv[2], &mt));
    if (mt != napi_number) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "mkdir: mode must be a number");
    }
    double dval = 0;
    NAPI_CHECK(napi_get_value_double(env, argv[2], &dval));
    if (dval != dval || dval == INFINITY) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "mkdir: mode must be an integer");
    }
    if (static_cast<double>(static_cast<int32_t>(dval)) != dval) {
      return ThrowCode(env, "PATH_UNSAFE",
                       "mkdir: mode must be an integer");
    }
  }

  int32_t mode = 0;
  if (!GetInt32(env, argv[2], mode))
    return nullptr;
  if (mode < 0 || mode > 0777) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "mkdir: mode must be 0..0777");
  }

  // mkdirat: exclusive (EEXIST if entry already exists), does not follow symlinks
  if (mkdirat(dir_fd, seg.value.c_str(), static_cast<mode_t>(mode)) < 0) {
    return ThrowErrno(env, "mkdirat", errno, seg.value.c_str());
  }

  // Fsync parent directory for durability
  int fsync_rc;
  do {
    fsync_rc = fsync(dir_fd);
  } while (fsync_rc < 0 && errno == EINTR);
  if (fsync_rc < 0) {
    int saved = errno;
    // mkdir succeeded but directory not synced — return error but do not
    // attempt rollback (rmdir) since the directory is now visible.
    return ThrowErrno(env, "fsync", saved, "<dir>");
  }

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// rmdir(handle, name) — fd-relative via unlinkat AT_REMOVEDIR
//
// Removes an empty directory. The entry must be a directory.
// After success, fsync the parent directory for durability.
// ---------------------------------------------------------------------------

static napi_value Rmdir(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "rmdir: unsafe segment");

  if (unlinkat(dir_fd, seg.value.c_str(), AT_REMOVEDIR) < 0) {
    return ThrowErrno(env, "unlinkat(AT_REMOVEDIR)", errno, seg.value.c_str());
  }

  // Fsync parent directory for durability
  int fsync_rc;
  do {
    fsync_rc = fsync(dir_fd);
  } while (fsync_rc < 0 && errno == EINTR);
  if (fsync_rc < 0) {
    int saved = errno;
    return ThrowErrno(env, "fsync", saved, "<dir>");
  }

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// unlink(handle, name)
// ---------------------------------------------------------------------------

static napi_value Unlink(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "unlink: unsafe segment");

  if (unlinkat(dir_fd, seg.value.c_str(), 0) < 0) {
    return ThrowErrno(env, "unlinkat", errno, seg.value.c_str());
  }

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// chmod(handle, name, mode) — fd-based via openat + fchmod (B5)
// ---------------------------------------------------------------------------

static napi_value Chmod(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  if (argc < 3)
    return ThrowCode(env, "PATH_UNSAFE", "chmod requires name and mode");

  auto seg = GetSegment(env, argv, argc, 1);
  if (!seg.ok)
    return ThrowCode(env, "PATH_UNSAFE", "chmod: unsafe segment");

  // Validate mode type (must be int32)
  {
    napi_valuetype mt;
    NAPI_CHECK(napi_typeof(env, argv[2], &mt));
    if (mt != napi_number) {
      return ThrowCode(env, "PATH_UNSAFE", "chmod: mode must be a number");
    }
    // Reject NaN and non-integer doubles
    double dval = 0;
    NAPI_CHECK(napi_get_value_double(env, argv[2], &dval));
    if (dval != dval || dval == INFINITY) {
      return ThrowCode(env, "PATH_UNSAFE", "chmod: mode must be an integer");
    }
    if (static_cast<double>(static_cast<int32_t>(dval)) != dval) {
      return ThrowCode(env, "PATH_UNSAFE", "chmod: mode must be an integer");
    }
  }

  int32_t mode = 0;
  if (!GetInt32(env, argv[2], mode))
    return nullptr;

  // Validate mode range 0..0777 (same as createTemp)
  if (mode < 0 || mode > 0777) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "chmod: mode must be 0..0777");
  }

  // Open file to get an fd — fd-based fchmod prevents symlink races (B5)
  int file_fd = openat(dir_fd, seg.value.c_str(),
                       O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (file_fd < 0)
    return ThrowErrno(env, "openat", errno, seg.value.c_str());

  // Verify it's a regular file
  struct stat st;
  if (fstat(file_fd, &st) < 0) {
    int saved = errno;
    SafeClose(file_fd);
    return ThrowErrno(env, "fstat", saved, seg.value.c_str());
  }
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
    SafeClose(file_fd);
    return ThrowCode(env, "PATH_UNSAFE",
                     "chmod: not a regular file or nlink!=1");
  }

  // Use fd-based fchmod
  if (fchmod(file_fd, mode) < 0) {
    int saved = errno;
    SafeClose(file_fd);
    return ThrowErrno(env, "fchmod", saved, seg.value.c_str());
  }

  SafeClose(file_fd);

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// fsync(handle)
// ---------------------------------------------------------------------------

static napi_value Fsync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd < 0)
    return ThrowCode(env, "PATH_UNSAFE", "handle is closed");

  int rc;
  do {
    rc = fsync(dir_fd);
  } while (rc < 0 && errno == EINTR);
  if (rc < 0) {
    return ThrowErrno(env, "fsync", errno, "<dir>");
  }

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// close(handle) — idempotent, no EINTR retry
// ---------------------------------------------------------------------------

static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int dir_fd = GetDirFd(env, argv[0]);
  if (dir_fd >= 0) {
    napi_value ext;
    NAPI_CHECK(napi_get_named_property(env, argv[0], "_handle", &ext));
    void* data = nullptr;
    NAPI_CHECK(napi_get_value_external(env, ext, &data));
    if (data) {
      int* fd_ptr = static_cast<int*>(data);
      SafeClose(*fd_ptr);
      *fd_ptr = -1;
    }
  }

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------

#define DEF_FN(name, fn)                                                       \
  do {                                                                         \
    napi_value _fn;                                                            \
    NAPI_CHECK(napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr,  \
                                    &_fn));                                    \
    NAPI_CHECK(napi_set_named_property(env, exports, name, _fn));              \
  } while (0)

// ---------------------------------------------------------------------------
// Test seam JavaScript interface
// Only available in test builds (SAFE_WRITE_TEST_SEAM=1).
// ---------------------------------------------------------------------------

#ifdef SAFE_WRITE_TEST_SEAM

// testSeamReset() — reset all test seam state.
static napi_value TestSeamResetJs(napi_env env, napi_callback_info /*info*/) {
  TestSeamReset();
  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// testSeamConfigure(point, count) — configure a failure point.
// point: string name of the failure point.
// count: -1 = fail every time, 0 = don't fail, N = fail N times.
static napi_value TestSeamConfigureJs(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  if (argc < 2) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamConfigure requires point and count");
  }

  // Get point string
  napi_valuetype t;
  NAPI_CHECK(napi_typeof(env, argv[0], &t));
  if (t != napi_string) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamConfigure: point must be a string");
  }
  char point[256];
  size_t point_len = 0;
  NAPI_CHECK(napi_get_value_string_utf8(env, argv[0], point, sizeof(point),
                                        &point_len));

  // Get count
  NAPI_CHECK(napi_typeof(env, argv[1], &t));
  if (t != napi_number) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamConfigure: count must be a number");
  }
  int32_t count = 0;
  NAPI_CHECK(napi_get_value_int32(env, argv[1], &count));

  TestSeamConfigure(point, count);

  napi_value undefined;
  NAPI_CHECK(napi_get_undefined(env, &undefined));
  return undefined;
}

// testSeamGetFailedCount(point) — get the number of times a failure point was triggered.
static napi_value TestSeamGetFailedCountJs(napi_env env,
                                           napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  if (argc < 1) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamGetFailedCount requires point");
  }

  // Get point string
  napi_valuetype t;
  NAPI_CHECK(napi_typeof(env, argv[0], &t));
  if (t != napi_string) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamGetFailedCount: point must be a string");
  }
  char point[256];
  size_t point_len = 0;
  NAPI_CHECK(napi_get_value_string_utf8(env, argv[0], point, sizeof(point),
                                        &point_len));

  int count = TestSeamGetFailedCount(point);

  napi_value result;
  NAPI_CHECK(napi_create_int32(env, count, &result));
  return result;
}

// testSeamGetCallCount(point) — get the number of times a failure point was called.
static napi_value TestSeamGetCallCountJs(napi_env env,
                                         napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  if (argc < 1) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamGetCallCount requires point");
  }

  // Get point string
  napi_valuetype t;
  NAPI_CHECK(napi_typeof(env, argv[0], &t));
  if (t != napi_string) {
    return ThrowCode(env, "PATH_UNSAFE",
                     "testSeamGetCallCount: point must be a string");
  }
  char point[256];
  size_t point_len = 0;
  NAPI_CHECK(napi_get_value_string_utf8(env, argv[0], point, sizeof(point),
                                        &point_len));

  int count = TestSeamGetCallCount(point);

  napi_value result;
  NAPI_CHECK(napi_create_int32(env, count, &result));
  return result;
}

// testSeamGetPoints() — get all available failure point names.
static napi_value TestSeamGetPointsJs(napi_env env,
                                      napi_callback_info /*info*/) {
  // List of all failure point names.
  static const char* points[] = {
      kSeamCreateObject,       kSeamCreateString,
      kSeamCreateExternal,     kSeamSetProperty,
      kSeamTypeTag,            kSeamOpenRootCreateObject,
      kSeamOpenDirCreateObject, kSeamReadFileCreateObject,
      kSeamAbortTempCreateObject, kSeamAbortUnlink,
  };
  static const size_t num_points = sizeof(points) / sizeof(points[0]);

  napi_value result;
  NAPI_CHECK(napi_create_array_with_length(env, num_points, &result));

  for (size_t i = 0; i < num_points; i++) {
    napi_value str;
    NAPI_CHECK(
        napi_create_string_utf8(env, points[i], NAPI_AUTO_LENGTH, &str));
    NAPI_CHECK(napi_set_element(env, result, i, str));
  }

  return result;
}

#endif  // SAFE_WRITE_TEST_SEAM

static napi_value Init(napi_env env, napi_value exports) {
  DEF_FN("openRoot", OpenRoot);
  DEF_FN("openDir", OpenDir);
  DEF_FN("readEntry", ReadEntry);
  DEF_FN("readFile", ReadFile);
  DEF_FN("createTemp", CreateTemp);
  DEF_FN("rename", Rename);
  DEF_FN("abortTemp", AbortTemp);
  DEF_FN("mkdir", Mkdir);
  DEF_FN("rmdir", Rmdir);
  DEF_FN("unlink", Unlink);
  DEF_FN("chmod", Chmod);
  DEF_FN("fsync", Fsync);
  DEF_FN("close", Close);

#ifdef SAFE_WRITE_TEST_SEAM
  // Test seam functions — only available in test builds.
  DEF_FN("testSeamReset", TestSeamResetJs);
  DEF_FN("testSeamConfigure", TestSeamConfigureJs);
  DEF_FN("testSeamGetFailedCount", TestSeamGetFailedCountJs);
  DEF_FN("testSeamGetCallCount", TestSeamGetCallCountJs);
  DEF_FN("testSeamGetPoints", TestSeamGetPointsJs);
#endif

  return exports;
}

NAPI_MODULE(safe_write, Init)
