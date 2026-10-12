import Foundation
import Hummingbird
import Logging

public enum PhotoKitServer {
    /// Requests photo library access if needed, then serves the HTTP API until terminated.
    public static func run(configuration: ServerConfiguration) async throws {
        var logger = Logger(label: "photokit-server")
        logger.logLevel = configuration.logLevel

        var status = PhotoLibrary.authorizationStatus
        if status == .notDetermined {
            logger.info("Requesting access to the Photos library. Allow it in the dialog.")
            status = await PhotoLibrary.requestAuthorization()
        }
        if status.allowsReading {
            logger.info("Photos library access: \(status.name)")
        } else {
            logger.error(
                "Photos library access: \(status.name). Allow the terminal app in System Settings > Privacy & Security > Photos, then restart the server."
            )
        }

        let media = Media(configuration: configuration, logger: logger)
        try media.prepareTemporaryDirectory()

        let app = Application(
            router: buildRouter(configuration: configuration, media: media),
            configuration: .init(address: .hostname("127.0.0.1", port: configuration.port), serverName: "photokit-server"),
            logger: logger
        )
        try await app.runService()
    }
}
