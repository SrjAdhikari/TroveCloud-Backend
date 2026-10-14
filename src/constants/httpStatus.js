//* src/constants/httpStatus.js

// Only the HTTP status codes this app uses, not the full list.
const httpStatus = Object.freeze({
	OK: 200,
	CREATED: 201,

	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	UNPROCESSABLE_ENTITY: 422,
	TOO_MANY_REQUESTS: 429,

	INTERNAL_SERVER_ERROR: 500,
});

export default httpStatus;
