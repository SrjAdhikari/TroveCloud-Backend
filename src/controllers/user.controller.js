//* src/controllers/user.controller.js

import httpStatus from "../constants/httpStatus.js";
import {
	updateProfile,
	uploadProfilePicture,
	formatUser,
} from "../services/user.service.js";

const { OK } = httpStatus;

export const updateProfileHandler = async (req, res) => {
	const { name } = req.body;
	const userId = req.user._id;

	const user = await updateProfile(userId, name);

	res.status(OK).json({
		success: true,
		message: "Profile updated successfully",
		data: await formatUser(user),
	});
};

export const uploadProfilePictureHandler = async (req, res) => {
	const userId = req.user._id;
	const updatedUser = await uploadProfilePicture(userId, req, {
		contentType: req.headers["content-type"],
		contentLength: req.headers["content-length"],
	});

	res.status(OK).json({
		success: true,
		message: "Profile picture updated successfully",
		data: await formatUser(updatedUser),
	});
};
