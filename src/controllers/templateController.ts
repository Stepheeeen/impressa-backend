import { Request, Response } from "express";
import ProductTemplate from "../models/ProductTemplate";

const normalizeStringArray = (value: any): string[] => {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (v === undefined || v === null ? "" : String(v).trim()))
    .filter((v) => v.length > 0);
};

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

// ✅ Create New Product Template (Supports Multiple Images)
export const createTemplate = async (req: Request, res: Response) => {
  try {
    const { products } = req.body;

    // ✅ Normalize input: allow single object OR array
    const productList = Array.isArray(products)
      ? products
      : products
      ? [products]
      : [];

    if (productList.length === 0) {
      return res.status(400).json({
        error: "No products provided",
      });
    }

    // ✅ Validate each product
    const preparedProducts = productList.map((product, index) => {
      const {
        title,
        itemType,
        category,
        imageUrls,
        price,
        sizes,
        colors,
        tags,
        customizable,
        isFeatured,
        description,
      } = product;

      if (
        !title ||
        !itemType ||
        !category ||
        !price ||
        !Array.isArray(imageUrls) ||
        imageUrls.length === 0
      ) {
        throw new Error(`Invalid product data at index ${index}`);
      }

      return {
        title,
        itemType,
        category,
        imageUrls,
        price,
        sizes: normalizeStringArray(sizes),
        colors: normalizeStringArray(colors),
        tags: normalizeStringArray(tags),
        customizable: customizable ?? false,
        isFeatured: isFeatured ?? false,
        description: description ?? null,
      };
    });

    // ✅ Bulk insert
    const templates = await ProductTemplate.insertMany(preparedProducts);

    return res.status(201).json({
      message: `${templates.length} product(s) uploaded successfully`,
      templates,
    });
  } catch (error: any) {
    console.error("🔥 Bulk Template Upload Error:", error);
    return res.status(500).json({
      error: error.message || "Failed to create product templates",
    });
  }
};



export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (req.body.sizes !== undefined) {
      req.body.sizes = normalizeStringArray(req.body.sizes);
    }
    if (req.body.colors !== undefined) {
      req.body.colors = normalizeStringArray(req.body.colors);
    }
    if (req.body.tags !== undefined) {
      req.body.tags = normalizeStringArray(req.body.tags);
    }

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

// ✅ Edit template safely
export const editTemplate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const allowedFields = [
      "title",
      "category",
      "itemType",
      "price",
      "imageUrls", // <- allow plural imageUrls
      "sizes",
      "colors",
      "tags",
      "customizable",
      "inStock",
      "isFeatured",
      "description",
    ];

    // Prevent unwanted fields from updating
    const updateData: any = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }

    if (updateData.sizes !== undefined) {
      updateData.sizes = normalizeStringArray(updateData.sizes);
    }
    if (updateData.colors !== undefined) {
      updateData.colors = normalizeStringArray(updateData.colors);
    }
    if (updateData.tags !== undefined) {
      updateData.tags = normalizeStringArray(updateData.tags);
    }

    const updated = await ProductTemplate.findByIdAndUpdate(id, updateData, {
      new: true,
    });

    if (!updated) {
      return res.status(404).json({ error: "Product not found" });
    }

    return res.json({
      message: "Product updated successfully",
      product: updated,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update product" });
  }
};

// ✅ Get single template by ID
export const getTemplateById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const template = await ProductTemplate.findById(id);

    if (!template) {
      return res.status(404).json({ error: "Product not found" });
    }

    return res.json(template);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch product" });
  }
};
