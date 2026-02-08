import { UserDocument } from "../../models/User"; // Adjust the path if needed

declare global {
    namespace Express {
        interface Request {
            user?: UserDocument; // or a minimal user shape { _id: string; role: string; ... }
            rawBody?: Buffer;
        }
    }
}