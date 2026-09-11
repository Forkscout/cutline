/**
 * The project's shared types name `MediaStream` (a recorder source holds
 * one), and the server type-checks those files without the DOM library —
 * deliberately, so server code cannot reach for `document` and typecheck.
 * The server never touches a stream; an opaque declaration is all it needs.
 */
interface MediaStream {
  readonly id: string;
}
