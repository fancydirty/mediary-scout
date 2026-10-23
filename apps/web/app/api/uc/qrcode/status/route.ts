import { createFamilyQrRoutes, ucFamilyRoutes } from "../../../cloud-family/qrcode";

const routes = createFamilyQrRoutes(ucFamilyRoutes);

export const GET = routes.status;
