/** Errors rendered as RFC 9457 problem+json by the app's error handler. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}

export const notFound = (what: string) => new HttpError(404, "Not found", `${what} was not found.`);
