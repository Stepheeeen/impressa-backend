import { Request, Response } from "express";
import ProductTemplate from "../models/ProductTemplate";

// Get all templates
export const getTemplates = async (req: Request, res: Response) => {
  try {
    const { category, itemType } = req.query;
    const filter: any = {};

    if (category) filter.category = category;
    if (itemType) filter.itemType = itemType;

    const templates = await ProductTemplate.find(filter).sort({ createdAt: -1 });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch templates" });
  }
};

// Create a new template
export const createTemplate = async (req: Request, res: Response) => {
  try {
    const {
      title,
      category,
      itemType,
      imageUrl,
      price,
      sizes,
      colors,
      tags
    } = req.body;

    const template = new ProductTemplate({
      title,
      category,
      itemType,
      imageUrl,
      price,
      sizes,
      colors,
      tags
    });

    await template.save();
    res.status(201).json(template);
  } catch (err) {
    res.status(400).json({ error: "Failed to create template" });
  }
};
