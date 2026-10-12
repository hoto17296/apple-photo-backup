import ArgumentParser
import Foundation
import Logging
import PhotoKitServer

@main
struct Command: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "photokit-server",
        abstract: "Serve the macOS Photos library over a local HTTP API (127.0.0.1 only)."
    )

    @Option(help: "Port to listen on. [env: PHOTOKIT_SERVER_PORT]")
    var port: Int = Int(ProcessInfo.processInfo.environment["PHOTOKIT_SERVER_PORT"] ?? "") ?? 8080

    @Option(help: "Require this bearer token from clients. [env: PHOTOKIT_SERVER_TOKEN]")
    var token: String?

    @Flag(inversion: .prefixedNo, help: "Download originals from iCloud by default when not stored locally. Clients can override with ?network=.")
    var network = true

    @Option(help: "Seconds to wait for a file (including iCloud downloads).")
    var downloadTimeout: Double = 300

    @Option(help: "Maximum number of file loads running at the same time.")
    var maxConcurrentDownloads: Int = 4

    @Option(help: "Log level (trace, debug, info, notice, warning, error, critical).")
    var logLevel: String = "info"

    func validate() throws {
        guard (1...65535).contains(port) else { throw ValidationError("--port must be between 1 and 65535") }
        guard downloadTimeout > 0 else { throw ValidationError("--download-timeout must be positive") }
        guard maxConcurrentDownloads > 0 else { throw ValidationError("--max-concurrent-downloads must be positive") }
        guard Logger.Level(rawValue: logLevel) != nil else { throw ValidationError("Unknown --log-level: \(logLevel)") }
        if let token, token.isEmpty { throw ValidationError("--token must not be empty") }
    }

    func run() async throws {
        let level = Logger.Level(rawValue: logLevel)!
        LoggingSystem.bootstrap { label in
            var handler = StreamLogHandler.standardError(label: label)
            handler.logLevel = level
            return handler
        }
        try await PhotoKitServer.run(
            configuration: .init(
                port: port,
                token: token ?? ProcessInfo.processInfo.environment["PHOTOKIT_SERVER_TOKEN"].flatMap { $0.isEmpty ? nil : $0 },
                allowNetworkAccess: network,
                downloadTimeout: downloadTimeout,
                maxConcurrentDownloads: maxConcurrentDownloads,
                logLevel: level
            )
        )
    }
}
