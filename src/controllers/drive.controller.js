//* src/controllers/drive.controller.js

import { importFromDrive } from "../services/drive.service.js";

import httpStatus from "../constants/httpStatus.js";

const { OK } = httpStatus;

const importDriveHandler = async (req, res) => {
	// Body shape (accessToken, items, parentDirId) is validated by
	// importDriveSchema (validateBody) before this handler runs.
	const { accessToken, items, parentDirId } = req.body;

	const user = req.user;
	const targetParentDirId = parentDirId || user.rootDirId.toString();

	const result = await importFromDrive(
		user._id,
		accessToken,
		items,
		targetParentDirId,
		user.storageLimit,
	);

	return res.status(OK).json({
		success: true,
		message: "Import completed",
		data: result,
	});
};

export { importDriveHandler };
