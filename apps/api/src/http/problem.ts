import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { HttpError } from "./errors";

/** Every error leaves as RFC 9457 problem+json, so clients handle one shape. 5xx details never leak. */
export function registerProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const send = (status: number, title: string, detail?: string, extra: Record<string, unknown> = {}) =>
      reply
        .status(status)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title,
          status,
          ...(detail ? { detail } : {}),
          instance: req.url,
          ...extra,
        });

    if (err instanceof HttpError) return send(err.status, err.title, err.detail);
    if (hasZodFastifySchemaValidationErrors(err)) {
      const where = err.validationContext; // "querystring" | "body" | "params" | "headers"
      const errors = err.validation.map((v) => ({
        path: [where, v.instancePath.replace(/^\//, "").replaceAll("/", ".")].filter(Boolean).join("."),
        message: v.message,
      }));
      return send(400, "Invalid request", "One or more parameters are invalid.", { errors });
    }
    if (err.statusCode && err.statusCode < 500) return send(err.statusCode, err.message);
    req.log.error({ err }, "unhandled error");
    return send(500, "Internal error", "Something went wrong on our side.");
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .type("application/problem+json")
      .send({ type: "about:blank", title: "Not found", status: 404, instance: req.url }),
  );
}
