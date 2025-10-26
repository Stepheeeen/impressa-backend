import { Request, Response } from "express";
import Design from "../models/Design";

// POST /api/designs
export const createDesign = async (req: any, res: Response) => {
  try {
    const { title, itemType, imageUrl, color, size, textLayers } = req.body;
    const design = await Design.create({
      user: req.user.id,
      title,
      itemType,
      imageUrl,
      color,
      size,
      textLayers,
    });
    res.status(201).json(design);
  } catch (err) {
    res.status(500).json({ error: "Failed to create design" });
  }
};

// GET /api/designs/:id
export const getDesign = async (req: any, res: Response) => {
  const design = await Design.findById(req.params.id);
  if (!design) return res.status(404).json({ error: "Not found" });
  res.json(design);
};

// GET /api/users/me/designs
export const getUserDesigns = async (req: any, res: Response) => {
  const designs = await Design.find({ user: req.user.id }).sort({ createdAt: -1 });
  res.json(designs);
};

// DELETE /api/designs/:id
export const deleteDesign = async (req: any, res: Response) => {
  await Design.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  res.status(200).json({ message: "Deleted" });
};