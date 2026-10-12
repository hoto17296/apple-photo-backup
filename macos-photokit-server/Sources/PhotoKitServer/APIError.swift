import Foundation
import Hummingbird

/// Error returned to clients as `{"error": {"code": ..., "message": ...}}`.
struct APIError: HTTPResponseError {
    let status: HTTPResponse.Status
    let code: String
    let message: String

    private struct Body: Encodable {
        struct Detail: Encodable {
            let code: String
            let message: String
        }
        let error: Detail
    }

    func response(from request: Request, context: some RequestContext) throws -> Response {
        try JSON.response(Body(error: .init(code: code, message: message)), status: status)
    }

    static func badRequest(_ message: String) -> APIError {
        APIError(status: .badRequest, code: "bad_request", message: message)
    }

    static let unauthorized = APIError(status: .unauthorized, code: "unauthorized", message: "Missing or invalid bearer token")

    static func notFound(_ message: String) -> APIError {
        APIError(status: .notFound, code: "not_found", message: message)
    }

    static let networkAccessRequired = APIError(
        status: .conflict, code: "network_access_required",
        message: "The resource is only available in iCloud. Retry with network=true to download it"
    )

    static let changeTokenExpired = APIError(
        status: .gone, code: "change_token_expired",
        message: "The change token is older than the available change history. Fetch everything again"
    )

    static func notAuthorized(_ status: String) -> APIError {
        APIError(
            status: .serviceUnavailable, code: "not_authorized",
            message: "Photos library access is not granted (status: \(status)). Allow access in System Settings > Privacy & Security > Photos"
        )
    }

    static let timeout = APIError(status: .gatewayTimeout, code: "timeout", message: "Timed out while loading the resource")

    static func internalError(_ message: String) -> APIError {
        APIError(status: .internalServerError, code: "internal_error", message: message)
    }
}
