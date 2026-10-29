/** An error with an HTTP status; the app's error handler turns it into JSON. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (why = "Not allowed") => new HttpError(403, why);
export const unauthorized = () => new HttpError(401, "Sign in first");
