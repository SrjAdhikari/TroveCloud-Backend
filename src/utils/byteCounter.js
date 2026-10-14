//* src/utils/byteCounter.js

import { Transform } from "node:stream";

// Counts bytes passing through a stream and errors out once the file limit or the remaining total limit is passed.
// `state.tripped` becomes true when that happens.
const createByteCounter = (perFileCap, remainingBudget = Infinity) => {
	const state = { bytes: 0, tripped: false };

	const stream = new Transform({
		transform(chunk, _enc, cb) {
			state.bytes += chunk.length;
			if (state.bytes > perFileCap || state.bytes > remainingBudget) {
				state.tripped = true;
				return cb(new Error("byte cap exceeded"));
			}
			cb(null, chunk);
		},
	});

	return { stream, state };
};

export default createByteCounter;
