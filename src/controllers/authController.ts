import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import Cart from "../models/Cart";
import Design from "../models/Design";
import DeviceToken from "../models/DeviceToken";
import Order from "../models/Order";
import User, { IUser } from "../models/User";
import { sendPasswordResetEmail } from "../services/email";

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
// Compared against when no account matches, so an unknown email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("impressa-timing-placeholder", BCRYPT_ROUNDS);
// Older accounts stored emails exactly as typed, so look them up case-insensitively.
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

const emailField = z
  .string({ error: "Enter your email address." })
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

const newPasswordField = z
  .string({ error: "Enter a password." })
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be 128 characters or fewer.");

const RegisterSchema = z.object({
  username: z
    .string({ error: "Choose a username." })
    .trim()
    .regex(/^[A-Za-z0-9_.]{3,30}$/, "Username must be 3–30 letters, numbers, dots or underscores."),
  email: emailField,
  password: newPasswordField,
});

const LoginSchema = z.object({
  email: z.string({ error: "Enter your email and password." }).trim().min(1, "Enter your email and password."),
  password: z.string({ error: "Enter your email and password." }).min(1, "Enter your email and password."),
});

const ForgotPasswordSchema = z.object({ email: emailField });

const ResetPasswordSchema = z.object({
  token: z
    .string({ error: "This reset link is invalid or has expired." })
    .regex(/^[a-f0-9]{64}$/, "This reset link is invalid or has expired."),
  password: newPasswordField,
});

const DeleteAccountSchema = z.object({
  password: z.string({ error: "Enter your password to confirm." }).min(1, "Enter your password to confirm."),
});

const signToken = (user: IUser) =>
  jwt.sign({ id: user.id, role: user.role, username: user.username, tv: user.tokenVersion ?? 0 }, env.JWT_SECRET, {
    expiresIn: "7d",
  });

const hashResetToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

async function createAccount(body: unknown, role: "user" | "admin") {
  const input = RegisterSchema.parse(body ?? {});

  const [emailTaken, usernameTaken] = await Promise.all([
    User.exists({ email: input.email }).collation(CASE_INSENSITIVE),
    User.exists({ username: input.username }).collation(CASE_INSENSITIVE),
  ]);
  if (emailTaken) throw new HttpError(409, "An account with this email already exists.");
  if (usernameTaken) throw new HttpError(409, "That username is taken.");

  return User.create({
    username: input.username,
    email: input.email,
    password: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    role,
  });
}

async function authenticate(body: unknown, role?: "admin") {
  const { email, password } = LoginSchema.parse(body ?? {});
  const user = await User.findOne(role ? { email, role } : { email }).collation(CASE_INSENSITIVE);
  const match = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !match) throw new HttpError(401, "Incorrect email or password.");
  return user;
}

// POST /api/auth/register
export const register = async (req: Request, res: Response) => {
  await createAccount(req.body, "user");
  res.status(201).json({ message: "Registered successfully" });
};

// POST /api/auth/register-admin (admins only)
export const adminRegister = async (req: Request, res: Response) => {
  const admin = await createAccount(req.body, "admin");
  res.status(201).json({ message: "Admin created successfully", admin: { email: admin.email, role: admin.role } });
};

// POST /api/auth/login
export const login = async (req: Request, res: Response) => {
  const user = await authenticate(req.body);
  res.json({
    token: signToken(user),
    user: { username: user.username, email: user.email, role: user.role },
  });
};

// POST /api/auth/admin-login
export const adminLogin = async (req: Request, res: Response) => {
  const admin = await authenticate(req.body, "admin");
  res.json({ token: signToken(admin), admin: { email: admin.email, role: admin.role } });
};

// GET /api/auth/me
export const getMe = async (req: Request, res: Response) => {
  res.json(req.user);
};

// POST /api/auth/forgot-password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = ForgotPasswordSchema.parse(req.body ?? {});
  const user = await User.findOne({ email }).collation(CASE_INSENSITIVE);

  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    // updateOne skips validation, so older accounts with incomplete profiles can still reset.
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordResetTokenHash: hashResetToken(token),
          passwordResetExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      }
    );

    const resetUrl = `${env.APP_URL.replace(/\/$/, "")}/reset-password?token=${token}`;
    // Not awaited, so the response takes the same time whether or not the account exists.
    sendPasswordResetEmail(user.email, resetUrl).catch((err) => console.error("Password reset email failed:", err));
  }

  res.json({ message: "If an account exists for that email, we've sent a link to reset your password." });
};

// POST /api/auth/reset-password
export const resetPassword = async (req: Request, res: Response) => {
  const { token, password } = ResetPasswordSchema.parse(req.body ?? {});

  // One atomic update, so a link can't be used twice.
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpires: { $gt: new Date() } },
    {
      $set: { password: await bcrypt.hash(password, BCRYPT_ROUNDS) },
      $unset: { passwordResetTokenHash: 1, passwordResetExpires: 1 },
      $inc: { tokenVersion: 1 },
    }
  );
  if (!user) throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");

  res.json({ message: "Password updated. You can now sign in." });
};

// DELETE /api/auth/me
export const deleteAccount = async (req: Request, res: Response) => {
  const { password } = DeleteAccountSchema.parse(req.body ?? {});
  const user = await User.findById(req.user!.id);
  if (!user) throw new HttpError(404, "Account not found.");
  if (user.role === "admin") throw new HttpError(403, "Admin accounts can't be deleted here.");
  // 400 rather than 401: clients treat 401 as an expired session and sign the user out.
  if (!(await bcrypt.compare(password, user.password))) throw new HttpError(400, "Incorrect password.");

  const undelivered = await Order.exists({ user: user._id, status: { $in: ["pending", "paid", "shipped"] } });
  if (undelivered) {
    throw new HttpError(409, "You have orders that haven't been delivered yet. You can delete your account once they arrive.");
  }

  // Order records are kept for accounting, with the customer's contact details removed.
  await Order.updateMany(
    { user: user._id },
    { $set: { "deliveryAddress.address": "Deleted", "deliveryAddress.phone": "Deleted" }, $unset: { email: 1 } }
  );
  await Promise.all([
    Cart.deleteMany({ user: user._id }),
    Design.deleteMany({ user: user._id }),
    DeviceToken.deleteMany({ user: user._id }),
  ]);
  await User.deleteOne({ _id: user._id });

  res.json({ message: "Your account has been deleted." });
};
