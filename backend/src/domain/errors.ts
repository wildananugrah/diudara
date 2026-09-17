/** Domain errors carry an HTTP status so the presentation layer never guesses. */
export class DomainError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} tidak ditemukan`, 404, "not_found");
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 422, "validation_error");
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Tidak terautentikasi") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Tidak memiliki akses") {
    super(message, 403, "forbidden");
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409, "conflict");
  }
}

/** 503, not 500: the API is healthy, one optional upstream integration is not. */
export class ServiceUnavailableError extends DomainError {
  constructor(message: string) {
    super(message, 503, "service_unavailable");
  }
}
