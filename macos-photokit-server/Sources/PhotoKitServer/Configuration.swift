import Logging

public struct ServerConfiguration: Sendable {
    /// Port to listen on. The server always binds to 127.0.0.1.
    public var port: Int
    /// Optional bearer token required from clients. Authentication is disabled when nil.
    public var token: String?
    /// Default for whether originals that are only in iCloud may be downloaded.
    /// Clients can override this per request with `?network=true|false`.
    public var allowNetworkAccess: Bool
    /// Seconds to wait for a resource (including iCloud downloads) before giving up.
    public var downloadTimeout: Double
    /// Maximum number of resource downloads / thumbnail renders running at the same time.
    public var maxConcurrentDownloads: Int
    public var logLevel: Logger.Level

    public init(
        port: Int = 8080,
        token: String? = nil,
        allowNetworkAccess: Bool = true,
        downloadTimeout: Double = 300,
        maxConcurrentDownloads: Int = 4,
        logLevel: Logger.Level = .info
    ) {
        self.port = port
        self.token = token
        self.allowNetworkAccess = allowNetworkAccess
        self.downloadTimeout = downloadTimeout
        self.maxConcurrentDownloads = maxConcurrentDownloads
        self.logLevel = logLevel
    }
}
