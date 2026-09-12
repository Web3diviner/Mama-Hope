export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: string,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFound = (entity: string, id: string): AppError =>
  new AppError('NOT_FOUND', `${entity} '${id}' was not found.`, 404);

export const forbidden = (message = 'You do not have permission to do that.'): AppError =>
  new AppError('FORBIDDEN', message, 403);
