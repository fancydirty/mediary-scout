import { createFamilyQrRoutes, quarkFamilyRoutes } from "../../cloud-family/qrcode";

const routes = createFamilyQrRoutes(quarkFamilyRoutes);

export const POST = routes.token;
