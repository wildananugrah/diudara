import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(message: string, readonly status: ContentfulStatusCode) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "invalid request") {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "already exists") {
    super(message, 409);
  }
}
