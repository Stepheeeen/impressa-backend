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

// ✅ Create New Product Template
export const createTemplate = async (req: Request, res: Response) => {
  try {
    const {
      title,
      itemType,
      category,
      imageUrl,       // ✅ Must come from Cloudinary (frontend)
      price,
      sizes,
      colors,
      tags,
      customizable,
      isFeatured
    } = req.body;

    // ✅ Validate required fields
    if (!title || !itemType || !category || !imageUrl || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Create Template Document
    const template = await ProductTemplate.create({
      title,
      itemType,
      category,
      imageUrl,
      price,
      sizes: sizes || [],
      colors: colors || [],
      tags: tags || [],
      customizable: customizable ?? true,
      isFeatured: isFeatured ?? false
    });

    return res.status(201).json({
      message: "Product uploaded successfully",
      template
    });

  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Failed to create product template" });
  }
};

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const updated = await ProductTemplate.findByIdAndUpdate(
      id,
      req.body,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({
      message: "Product updated successfully",
      product: updated,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update product" });
  }
};

export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const deleted = await ProductTemplate.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete product" });
  }
};

export const setProductStock = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { inStock } = req.body;

    const updated = await ProductTemplate.findByIdAndUpdate(
      id,
      { inStock },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({
      message: `Product marked as ${inStock ? "in stock" : "out of stock"}`,
      product: updated,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update stock status" });
  }
};
