import Foundation
import SystemConfiguration
import Security
import Darwin

// The production executable has no fixture switch or arbitrary configuration RPC.
enum Failure: String, Error { case invalid, busy, authorization, storage, configuration }
let managed = ["HTTPEnable", "HTTPProxy", "HTTPPort", "HTTPSEnable", "HTTPSProxy", "HTTPSPort", "SOCKSEnable", "SOCKSProxy", "SOCKSPort", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]
func equal(_ a: Any?, _ b: Any?) -> Bool {
  if a == nil && b == nil { return true }
  guard let a = a as? NSObject, let b = b as? NSObject else { return false }
  return a.isEqual(b)
}
func verifyApplied(_ expected: [String: Any], _ applied: [String: Any]?, active: Bool, hasProtocol: Bool) throws {
  guard let applied = applied else {
    // Disabled services and services in another Location legitimately have no
    // published Setup proxy key. A removed original protocol is likewise absent.
    guard !active || (!hasProtocol && expected.isEmpty) else { throw Failure.configuration }
    return
  }
  guard managed.allSatisfy({ equal(applied[$0], expected[$0]) }) else { throw Failure.configuration }
}
func waitForApplied(timeout: TimeInterval = 2, _ verify: () throws -> Void) throws {
  let deadline = ProcessInfo.processInfo.systemUptime + timeout
  while true {
    do { try verify(); return }
    catch Failure.configuration {
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw Failure.configuration }
      Thread.sleep(forTimeInterval: 0.025)
    }
  }
}
func packed(_ value: [String: Any]) throws -> Data { try PropertyListSerialization.data(fromPropertyList: value, format: .binary, options: 0) }
func unpacked(_ value: Data) throws -> [String: Any] { guard let result = try PropertyListSerialization.propertyList(from: value, format: nil) as? [String: Any] else { throw Failure.storage }; return result }
func securePath(_ path: String) throws {
  guard path.hasPrefix("/"), !path.contains("/../"), !path.contains("/./") else { throw Failure.storage }
  var current = ""
  for component in path.split(separator: "/") {
    current += "/" + component
    var info = stat()
    if lstat(current, &info) != 0 { if errno == ENOENT { continue }; throw Failure.storage }
    guard (info.st_mode & S_IFMT) != S_IFLNK, info.st_uid == 0 || info.st_uid == getuid(), ((info.st_mode & 0o002) == 0 || (info.st_mode & S_ISVTX) != 0), ((info.st_mode & 0o020) == 0 || info.st_gid == 0 || info.st_gid == 80) else { throw Failure.storage }
    if (info.st_mode & S_IFMT) == S_IFREG && info.st_nlink != 1 { throw Failure.storage }
  }
}
func readFile(_ path: String) throws -> Data? {
  try securePath(path)
  let fd = open(path, O_RDONLY | O_NOFOLLOW)
  if fd < 0 { if errno == ENOENT { return nil }; throw Failure.storage }
  defer { close(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_nlink == 1, info.st_size <= 1048576, (info.st_mode & S_IFMT) == S_IFREG else { throw Failure.storage }
  let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: 1048577) ?? Data()
  guard data.count <= 1048576 else { throw Failure.storage }
  return data
}
func writeFile(_ path: String, _ data: Data) throws {
  try securePath(path)
  let temp = path + "." + UUID().uuidString
  let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  guard fd >= 0 else { throw Failure.storage }
  defer { close(fd); unlink(temp) }
  try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
  guard fsync(fd) == 0, rename(temp, path) == 0 else { throw Failure.storage }
  let parent = open((path as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY)
  defer { close(parent) }
  guard parent >= 0, fsync(parent) == 0 else { throw Failure.storage }
}
func identity(_ pid: Int32) -> String? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
  return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}
struct Entry: Codable { let original: Data; let expected: Data; let hadProtocol: Bool }
struct Journal: Codable { let version: Int; let pid: Int32; let identity: String; let entries: [String: Entry] }
protocol Backend {
  func begin(_ write: Bool) throws
  func end()
  func read() throws -> [String: [String: Any]]
  func hasProtocol(_ id: String) -> Bool
  func eligible(_ id: String) -> Bool
  func write(_ values: [String: [String: Any]], remove: Set<String>) throws
  func applyAndVerify(_ values: [String: [String: Any]]) throws
}
final class SystemBackend: Backend {
  var auth: AuthorizationRef?
  var prefs: SCPreferences?
  var preferencesLocked = false
  var services: [String: SCNetworkService] = [:]
  var currentServiceIDs = Set<String>()
  deinit { if let auth = auth { AuthorizationFree(auth, []) } }
  func begin(_ write: Bool) throws {
    if write && auth == nil {
      var created: AuthorizationRef?
      guard AuthorizationCreate(nil, nil, [], &created) == errAuthorizationSuccess, let created = created else { throw Failure.authorization }
      // This is the right enforced by SCHelper for actual network changes;
      // system.preferences.network only unlocks the Network settings pane.
      let status = "system.services.systemconfiguration.network".withCString { name -> OSStatus in
        var item = AuthorizationItem(name: name, valueLength: 0, value: nil, flags: 0)
        return withUnsafeMutablePointer(to: &item) { pointer in
          var rights = AuthorizationRights(count: 1, items: pointer)
          return AuthorizationCopyRights(created, &rights, nil, [.interactionAllowed, .extendRights, .preAuthorize], nil)
        }
      }
      guard status == errAuthorizationSuccess else { AuthorizationFree(created, []); throw Failure.authorization }
      auth = created
    }
    prefs = write ? SCPreferencesCreateWithAuthorization(nil, "XingMang System Proxy" as CFString, nil, auth) : SCPreferencesCreate(nil, "XingMang System Proxy" as CFString, nil)
    guard let prefs = prefs else { throw Failure.configuration }
    // Reading preferences needs no lock or authorization; acquiring the write
    // lock itself may require privileges, even before any mutation.
    if write {
      guard SCPreferencesLock(prefs, false) else { self.prefs = nil; throw Failure.configuration }
      preferencesLocked = true
    }
  }
  func end() { if preferencesLocked, let prefs = prefs { SCPreferencesUnlock(prefs) }; preferencesLocked = false; prefs = nil; services = [:] }
  func read() throws -> [String: [String: Any]] {
    guard let prefs = prefs, let list = SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] else { throw Failure.configuration }
    guard let currentSet = SCNetworkSetCopyCurrent(prefs), let active = SCNetworkSetCopyServices(currentSet) as? [SCNetworkService] else { throw Failure.configuration }
    currentServiceIDs = Set(active.compactMap { SCNetworkServiceGetServiceID($0) as String? })
    var result: [String: [String: Any]] = [:]
    for service in list {
      guard let interface = SCNetworkServiceGetInterface(service), let kind = SCNetworkInterfaceGetInterfaceType(interface) as String?, ["Ethernet", "IEEE80211"].contains(kind), let bsd = SCNetworkInterfaceGetBSDName(interface) as String?, bsd.hasPrefix("en"), let id = SCNetworkServiceGetServiceID(service) as String? else { continue }
      services[id] = service
      let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies)
      result[id] = proto.flatMap { SCNetworkProtocolGetConfiguration($0) as? [String: Any] } ?? [:]
    }
    return result
  }
  func eligible(_ id: String) -> Bool { currentServiceIDs.contains(id) && (services[id].map { SCNetworkServiceGetEnabled($0) } ?? false) }
  func hasProtocol(_ id: String) -> Bool { services[id].flatMap { SCNetworkServiceCopyProtocol($0, kSCNetworkProtocolTypeProxies) } != nil }
  func write(_ values: [String: [String: Any]], remove: Set<String>) throws {
    guard let prefs = prefs else { throw Failure.configuration }
    for (id, value) in values {
      guard let service = services[id] else { throw Failure.configuration }
      if remove.contains(id) { guard SCNetworkServiceRemoveProtocolType(service, kSCNetworkProtocolTypeProxies) else { throw Failure.configuration }; continue }
      if !hasProtocol(id) { guard SCNetworkServiceAddProtocolType(service, kSCNetworkProtocolTypeProxies) else { throw Failure.configuration } }
      guard let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies), SCNetworkProtocolSetConfiguration(proto, value as CFDictionary) else { throw Failure.configuration }
    }
    guard SCPreferencesCommitChanges(prefs) else { throw Failure.configuration }
    SCPreferencesSynchronize(prefs)
  }
  func applyAndVerify(_ values: [String: [String: Any]]) throws {
    guard let prefs = prefs, SCPreferencesApplyChanges(prefs), let store = SCDynamicStoreCreate(nil, "XingMang Proxy Verification" as CFString, nil, nil) else { throw Failure.configuration }
    // Preferences commit is not proof of application. Verify the published
    // per-service Setup state, including retries whose disk snapshot is original.
    // Apply queues a configd notification; its successful return does not mean
    // PreferencesMonitor has already published the new Setup dictionaries.
    try waitForApplied {
      for (id, expected) in values {
        let key = "Setup:/Network/Service/\(id)/Proxies" as CFString
        let applied = SCDynamicStoreCopyValue(store, key) as? [String: Any]
        try verifyApplied(expected, applied, active: eligible(id), hasProtocol: hasProtocol(id))
      }
    }
  }
}
#if PROXY_TEST_BACKEND
final class FixtureBackend: Backend {
  let path: String
  init(_ path: String) { self.path = path }
  func begin(_ write: Bool) throws { if write, let delay = try object()["authorizationDelayMs"] as? Int { Thread.sleep(forTimeInterval: Double(min(max(delay, 0), 1000)) / 1000) }; if write, try object()["denyAuthorization"] as? Bool == true { throw Failure.authorization } }
  func end() {}
  func object() throws -> [String: Any] { guard let data = try readFile(path), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.storage }; return value }
  func read() throws -> [String: [String: Any]] { try object()["services"] as? [String: [String: Any]] ?? [:] }
  func applyAndVerify(_ values: [String: [String: Any]]) throws {
    var value = try object()
    if value["failApplyOnce"] as? Bool == true { value["failApplyOnce"] = false; try writeFile(path, JSONSerialization.data(withJSONObject: value)); throw Failure.configuration }
    try waitForApplied(timeout: 0.2) { try publishAndVerify(values) }
  }
  func publishAndVerify(_ values: [String: [String: Any]]) throws {
    var value = try object()
    if let remaining = value["delayAppliedReads"] as? Int, remaining > 0 {
      value["delayAppliedReads"] = remaining - 1
      try writeFile(path, JSONSerialization.data(withJSONObject: value))
      let applied = value["applied"] as? [String: [String: Any]] ?? [:]
      for (id, expected) in values { try verifyApplied(expected, applied[id], active: eligible(id), hasProtocol: hasProtocol(id)) }
      return
    }
    var nextApplied = try read()
    for id in (value["inactiveServices"] as? [String] ?? []) + (value["missingAppliedServices"] as? [String] ?? []) { nextApplied[id] = nil }
    let previousApplied = value["applied"] as? [String: [String: Any]] ?? [:]
    for id in value["staleAppliedServices"] as? [String] ?? [] { nextApplied[id] = previousApplied[id] }
    value["applied"] = nextApplied
    try writeFile(path, JSONSerialization.data(withJSONObject: value))
    let applied = value["applied"] as? [String: [String: Any]] ?? [:]
    for (id, expected) in values { try verifyApplied(expected, applied[id], active: eligible(id), hasProtocol: hasProtocol(id)) }
  }
  func eligible(_ id: String) -> Bool { let inactive = (try? object())?["inactiveServices"] as? [String] ?? []; return !inactive.contains(id) }
  func hasProtocol(_ id: String) -> Bool { true }
  func write(_ values: [String: [String: Any]], remove: Set<String>) throws { var value = try object(); if value["failWrite"] as? Bool == true { throw Failure.configuration }; var services = try read(); for (id, config) in values { services[id] = config; if value["partialWrite"] as? Bool == true { break } }; value["services"] = services; try writeFile(path, JSONSerialization.data(withJSONObject: value)); if value["partialWrite"] as? Bool == true { throw Failure.configuration } }
}
#endif
final class ConnectionState {
  private let mutex = NSLock()
  private var closed = false
  private var queued = 0
  func cancel() { mutex.lock(); closed = true; mutex.unlock() }
  func check() throws { mutex.lock(); defer { mutex.unlock() }; if closed { throw Failure.invalid } }
  func reserve() -> Bool { mutex.lock(); defer { mutex.unlock() }; guard !closed, queued < 8 else { closed = true; return false }; queued += 1; return true }
  func completed() { mutex.lock(); queued -= 1; mutex.unlock() }
}
final class Controller {
  let path: String
  let lockPath: String
  let backend: Backend
  let connection: ConnectionState
  var lock: Int32 = -1
  init(_ path: String, _ lockPath: String, _ backend: Backend, _ connection: ConnectionState) { self.path = path; self.lockPath = lockPath; self.backend = backend; self.connection = connection }
  func acquire() throws {
    if lock >= 0 { return }
    try securePath(lockPath)
    let fd = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw Failure.storage }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1, (info.st_mode & S_IFMT) == S_IFREG else { close(fd); throw Failure.storage }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw Failure.busy }
    lock = fd
  }
  func release() { if lock >= 0 { flock(lock, LOCK_UN); close(lock); lock = -1 } }
  func journal() throws -> Journal? {
    guard let data = try readFile(path) else { return nil }
    let j = try JSONDecoder().decode(Journal.self, from: data)
    guard j.version == 1, j.pid > 0, j.identity.range(of: "^[0-9]{1,20}:[0-9]{1,6}$", options: .regularExpression) != nil, !j.entries.isEmpty, j.entries.count <= 256 else { throw Failure.storage }
    var journalPort: Int?
    for (id, entry) in j.entries {
      guard !id.isEmpty, id.utf8.count <= 256 else { throw Failure.storage }
      _ = try unpacked(entry.original)
      let expected = try unpacked(entry.expected)
      guard let port = expected["HTTPPort"] as? Int, (1024...65535).contains(port), journalPort == nil || journalPort == port else { throw Failure.storage }
      journalPort = port
      for prefix in ["HTTP", "HTTPS", "SOCKS"] {
        guard equal(expected[prefix + "Enable"], 1), equal(expected[prefix + "Proxy"], "127.0.0.1"), equal(expected[prefix + "Port"], port) else { throw Failure.storage }
      }
      guard equal(expected["ProxyAutoConfigEnable"], 0), equal(expected["ProxyAutoDiscoveryEnable"], 0) else { throw Failure.storage }
    }
    if j.pid != getpid(), let current = identity(j.pid), current == j.identity { throw Failure.busy }
    return j
  }
  func restore() throws {
    // No journal means no authorization UI, including routine startup recovery.
    guard try readFile(path) != nil else { release(); return }
    try acquire()
    guard let j = try journal() else { return }
    try backend.begin(true); defer { backend.end() }
    let current = try backend.read()
    var updates: [String: [String: Any]] = [:]
    var applicationTargets: [String: [String: Any]] = [:]
    var remove = Set<String>()
    for (id, entry) in j.entries {
      guard var config = current[id] else { continue }
      let expected = try unpacked(entry.expected), original = try unpacked(entry.original)
      if managed.allSatisfy({ equal(config[$0], original[$0]) }) { applicationTargets[id] = config; continue }
      // Treat endpoint and activation keys as one ownership unit: never splice an
      // old host/port into another client's new configuration.
      guard managed.allSatisfy({ equal(config[$0], expected[$0]) }) else {
        // Never release recovery while an enabled endpoint may still depend on
        // this core. This also catches partial host/port/enable writes.
        let ambiguous = ["HTTP", "HTTPS", "SOCKS"].contains { prefix in
          let active = !equal(config[prefix + "Enable"], 0) && config[prefix + "Enable"] != nil
          return active && (equal(config[prefix + "Proxy"], "127.0.0.1") || equal(config[prefix + "Port"], expected[prefix + "Port"]))
        }
        if ambiguous { throw Failure.configuration }
        continue
      }
      for key in managed { config[key] = original[key] }
      updates[id] = config
      applicationTargets[id] = config
      if !entry.hadProtocol && config.isEmpty { remove.insert(id) }
    }
    if !updates.isEmpty { try backend.write(updates, remove: remove) }
    try backend.applyAndVerify(applicationTargets)
    let verified = try backend.read()
    for (id, config) in updates { guard let actual = verified[id], NSDictionary(dictionary: config).isEqual(to: actual) else { throw Failure.configuration } }
    guard unlink(path) == 0 || errno == ENOENT else { throw Failure.storage }
    release()
  }
  func enable(_ port: Int) throws {
    try connection.check()
    guard (1024...65535).contains(port) else { throw Failure.invalid }
    try acquire()
    if try readFile(path) != nil { try restore(); try acquire() }
    do { try applyEnable(port) }
    catch { let originalError = error; try? restore(); throw originalError }
  }
  func applyEnable(_ port: Int) throws {
    try connection.check()
    try backend.begin(true); defer { backend.end() }
    try connection.check()
    let current = try backend.read().filter { backend.eligible($0.key) }
    guard !current.isEmpty, current.count <= 256, current.keys.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw Failure.configuration }
    var entries: [String: Entry] = [:], updates: [String: [String: Any]] = [:]
    for (id, original) in current {
      var config = original
      for prefix in ["HTTP", "HTTPS", "SOCKS"] { config[prefix + "Enable"] = 1; config[prefix + "Proxy"] = "127.0.0.1"; config[prefix + "Port"] = port }
      config["ProxyAutoConfigEnable"] = 0; config["ProxyAutoDiscoveryEnable"] = 0
      entries[id] = Entry(original: try packed(original), expected: try packed(config), hadProtocol: backend.hasProtocol(id)); updates[id] = config
    }
    guard let start = identity(getpid()) else { throw Failure.storage }
    let encoded = try JSONEncoder().encode(Journal(version: 1, pid: getpid(), identity: start, entries: entries))
    guard encoded.count <= 1048576 else { throw Failure.storage }
    try connection.check()
    try writeFile(path, encoded)
    try connection.check()
    try backend.write(updates, remove: [])
    try backend.applyAndVerify(updates)
    let verified = try backend.read()
    for (id, config) in updates { guard let actual = verified[id], NSDictionary(dictionary: config).isEqual(to: actual) else { throw Failure.configuration } }
  }
}
func main() throws {
  let args = CommandLine.arguments
  guard args.count >= 3, args[1] == "--journal" else { throw Failure.invalid }
  let path = args[2]
  try securePath(path)
  var backend: Backend = SystemBackend()
  var lockPath = NSHomeDirectory() + "/Library/Application Support/XingMangProxy/owner.lock"
#if PROXY_TEST_BACKEND
  guard args.count == 5, args[3] == "--fixture" else { throw Failure.invalid }
  backend = FixtureBackend(args[4]); lockPath = path + ".lock"
#else
  guard args.count == 3 else { throw Failure.invalid }
  let directory = (lockPath as NSString).deletingLastPathComponent
  try securePath(directory)
  try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
#endif
  let connection = ConnectionState()
  let controller = Controller(path, lockPath, backend, connection)
  // Signal sources run on the same serial queue as RPC operations. No unsafe
  // Foundation/SystemConfiguration work is performed in a signal handler.
  let queue = DispatchQueue(label: "xingmang.proxy")
  var disconnected = false
  func cleanup() { disconnected = true; do { try controller.restore(); exit(0) } catch Failure.authorization { exit(1) } catch { /* Retain auth and journal; retry while disconnected. */ } }
  var sources: [DispatchSourceSignal] = []
  for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global()); source.setEventHandler { connection.cancel(); queue.async { cleanup() } }; source.resume(); sources.append(source) }
  signal(SIGPIPE, SIG_IGN)
  let retry = DispatchSource.makeTimerSource(queue: queue)
  retry.schedule(deadline: .now() + 5, repeating: 5)
  retry.setEventHandler { if disconnected { cleanup() } }; retry.resume()
  DispatchQueue.global().async {
    var pending = Data()
    while true {
      var byte: UInt8 = 0
      let count = Darwin.read(STDIN_FILENO, &byte, 1)
      if count <= 0 { connection.cancel(); queue.async { cleanup(); retry.schedule(deadline: .now() + 5, repeating: 5) }; break }
      if byte != 10 { pending.append(byte); if pending.count > 4096 { connection.cancel(); queue.async { cleanup(); retry.schedule(deadline: .now() + 5, repeating: 5) }; break }; continue }
      let data = pending; pending.removeAll(keepingCapacity: true)
      guard connection.reserve() else { queue.async { cleanup() }; break }
      queue.async {
        defer { connection.completed() }
        var id = 0
        var reply: [String: Any]
        do {
          guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let requestId = request["id"] as? Int, requestId > 0, let op = request["op"] as? String, Set(request.keys).isSubset(of: ["id", "op", "port"]) else { throw Failure.invalid }
          id = requestId
          switch op {
          case "enable": guard let port = request["port"] as? Int else { throw Failure.invalid }; try controller.enable(port)
          case "restore", "recover", "stop": try controller.restore()
          case "inspect": try backend.begin(false); defer { backend.end() }; _ = try backend.read()
          default: throw Failure.invalid
          }
          reply = ["id": id, "ok": true]
          if let output = try? JSONSerialization.data(withJSONObject: reply) { FileHandle.standardOutput.write(output + Data([10])) }
          if op == "stop" { exit(0) }
          return
        } catch { reply = ["id": id, "ok": false, "error": (error as? Failure)?.rawValue ?? "storage"] }
        if let output = try? JSONSerialization.data(withJSONObject: reply) { FileHandle.standardOutput.write(output + Data([10])) }
      }
    }
  }
  withExtendedLifetime(sources) { dispatchMain() }
}
do { try main() } catch { exit(1) }
