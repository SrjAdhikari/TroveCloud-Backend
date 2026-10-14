//* src/errors/AppError.js

// Custom error class for handling application errors
class AppError extends Error {
	constructor(message, statusCode = 500, code = "INTERNAL_ERROR") {
		super(message);

		this.name = this.constructor.name;
		this.statusCode = statusCode;
		this.code = code;
		this.isOperational = true;

		Error.captureStackTrace(this, this.constructor);
	}
}

export default AppError;
