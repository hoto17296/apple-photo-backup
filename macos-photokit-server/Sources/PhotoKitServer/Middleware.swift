import Foundation
import Hummingbird
import Logging

/// Logs one line per request: method, path, status and duration.
struct RequestLogMiddleware<Context: RequestContext>: RouterMiddleware {
    func handle(_ request: Request, context: Context, next: (Request, Context) async throws -> Response) async throws -> Response {
        let start = ContinuousClock.now
        func log(_ status: HTTPResponse.Status) {
            let elapsed = ContinuousClock.now - start
            let ms = Double(elapsed.components.attoseconds) / 1e15 + Double(elapsed.components.seconds) * 1000
            context.logger.info("\(request.method) \(request.uri.path) \(status.code) \(String(format: "%.1f", ms))ms")
        }
        do {
            let response = try await next(request, context)
            log(response.status)
            return response
        } catch let error as HTTPResponseError {
            log(error.status)
            throw error
        } catch {
            log(.internalServerError)
            throw error
        }
    }
}

/// Requires `Authorization: Bearer <token>` on every request except `/health` and `/openapi.json`.
struct BearerTokenMiddleware<Context: RequestContext>: RouterMiddleware {
    let token: String

    static var exemptPaths: Set<String> { ["/health", "/openapi.json"] }

    func handle(_ request: Request, context: Context, next: (Request, Context) async throws -> Response) async throws -> Response {
        guard Self.exemptPaths.contains(request.uri.path) || Self.matches(request.headers[.authorization], token: token) else {
            throw APIError.unauthorized
        }
        return try await next(request, context)
    }

    static func matches(_ header: String?, token: String) -> Bool {
        guard let header, header.hasPrefix("Bearer ") else { return false }
        let given = Array(header.dropFirst("Bearer ".count).utf8)
        let expected = Array(token.utf8)
        guard given.count == expected.count else { return false }
        // Constant-time comparison.
        return zip(given, expected).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

/// Returns 503 while the process has no read access to the photo library.
struct PhotosAuthorizationMiddleware<Context: RequestContext>: RouterMiddleware {
    static var exemptPaths: Set<String> { ["/health", "/openapi.json", "/library"] }

    func handle(_ request: Request, context: Context, next: (Request, Context) async throws -> Response) async throws -> Response {
        if !Self.exemptPaths.contains(request.uri.path) {
            let status = PhotoLibrary.authorizationStatus
            guard status.allowsReading else {
                throw APIError.notAuthorized(status.name)
            }
        }
        return try await next(request, context)
    }
}
