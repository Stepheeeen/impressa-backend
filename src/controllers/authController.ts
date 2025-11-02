import { Request, Response } from "express";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

// Register user
export const register = async (req: Request, res: Response) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: "Missing request body" });
        }

        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const exists = await User.findOne({ email });
        if (exists) return res.status(400).json({ error: "User already exists" });

        const hashed = await bcrypt.hash(password, 10);
        await User.create({ username, email, password: hashed });

        res.status(201).json({ message: "Registered successfully" });
    } catch (err) {
        console.error("Registration error:", err);
        res.status(500).json({ error: "Failed to register user" });
    }
};

export const adminRegister = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        const exists = await User.findOne({ email });
        if (exists) return res.status(400).json({ error: "Admin already exists" });

        const hashed = await bcrypt.hash(password, 10);

        const admin = await User.create({
            email,
            password: hashed,
            role: "admin",
        });

        // return created admin info (excluding password)
        res.status(201).json({ message: "Admin created successfully", admin: { email: admin.email, role: admin.role } });
    } catch (err) {
        res.status(500).json({ error: "Failed to create admin" });
    }
};

// Login user/admin
export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const user = await User.findOne({ email }).select("+password");
        if (!user) return res.status(404).json({ error: "User not found" });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign({ id: user._id, role: user.role, username: user.username, }, JWT_SECRET, {
            expiresIn: "7d",
        });

        res.json({
            token,
            user: { email: user.email, role: user.role },
        });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Login failed" });
    }
};

// ADMIN LOGIN
export const adminLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const admin = await User.findOne({ email, role: "admin" });
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin._id, role: "admin" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, admin: { email: admin.email, role: admin.role } });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
};

// Get current user
export const getMe = async (req: any, res: Response) => {
    try {
        const user = await User.findById(req.user.id).select("-password");
        res.json(user);
    } catch (err) {
        console.error("getMe error:", err);
        res.status(401).json({ error: "Unauthorized" });
    }
};
