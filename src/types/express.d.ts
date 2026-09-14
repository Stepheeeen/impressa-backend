import { IMerchant } from "../models/Merchant";
import { IUser } from "../models/User";

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      // Set by requireApprovedMerchant.
      merchant?: IMerchant;
      rawBody?: Buffer;
    }
  }
}

export {};
