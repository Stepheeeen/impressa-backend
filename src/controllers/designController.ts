import { Request, Response } from "express";
import { HttpError } from "../middleware/errorHandler";
import Design from "../models/Design";

// POST /api/designs
export const createDesign = async (req: Request, res: Response) => {
  const { title, itemType, imageUrl, color, size, textLayers } = req.body ?? {};
  const design = await Design.create({
    user: req.user!.id,
    title,
    itemType,
    imageUrl,
    color,
    size,
    textLayers,
  });
  res.status(201).json(design);
};

// GET /api/designs/:id
export const getDesign = async (req: Request, res: Response) => {
  const user = req.user!;
  const design = await Design.findById(req.params.id);
  // Only the owner or an admin can see a design; everyone else gets the same 404 as a missing one.
  if (!design || (design.user.toString() !== user.id && user.role !== "admin")) {
    throw new HttpError(404, "Design not found");
  }
  res.json(design);
};

// GET /api/designs/user/me
export const getUserDesigns = async (req: Request, res: Response) => {
  const designs = await Design.find({ user: req.user!.id }).sort({ createdAt: -1 });
  res.json(designs);
};

// DELETE /api/designs/:id
export const deleteDesign = async (req: Request, res: Response) => {
  await Design.findOneAndDelete({ _id: req.params.id, user: req.user!.id });
  res.status(200).json({ message: "Deleted" });
};
