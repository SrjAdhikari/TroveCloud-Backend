//* src/controllers/admin/overview.controller.js

import httpStatus from "../../constants/httpStatus.js";
import { getSystemOverview } from "../../services/admin/overview.service.js";

const { OK } = httpStatus;

export const getOverviewHandler = async (req, res) => {
	const data = await getSystemOverview();

	res.status(OK).json({
		success: true,
		message: "System overview fetched successfully",
		data,
	});
};
