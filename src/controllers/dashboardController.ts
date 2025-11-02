import { Request, Response } from "express";
import Order from "../models/Order";
import ProductTemplate from "../models/ProductTemplate";
import User from "../models/User";

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // ✅ TOTAL ORDERS
    const totalOrders = await Order.countDocuments();

    // ✅ TOTAL PRODUCTS (templates)
    const totalProducts = await ProductTemplate.countDocuments();

    // ✅ TOTAL CUSTOMERS
    const totalCustomers = await User.countDocuments({ role: "user" });

    // ✅ TOTAL REVENUE (sum of all paid orders)
    const revenueAgg = await Order.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
    ]);

    const totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].revenue : 0;

    // ✅ LAST MONTH ORDERS
    const lastMonthOrders = await Order.countDocuments({
      createdAt: { $gte: lastMonth },
    });

    // ✅ LAST MONTH REVENUE
    const lastMonthRevAgg = await Order.aggregate([
      {
        $match: {
          status: "paid",
          createdAt: { $gte: lastMonth },
        },
      },
      { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
    ]);

    const lastMonthRevenue =
      lastMonthRevAgg.length > 0 ? lastMonthRevAgg[0].revenue : 0;

    // ✅ GROWTH CALCULATIONS
    const revenueGrowth =
      lastMonthRevenue > 0
        ? ((totalRevenue - lastMonthRevenue) / lastMonthRevenue) * 100
        : 0;

    const orderGrowth =
      lastMonthOrders > 0
        ? ((totalOrders - lastMonthOrders) / lastMonthOrders) * 100
        : 0;

    const productGrowth = 8; // Placeholder until you implement a product tracking system
    const customerGrowth = 12; // Placeholder

    // ✅ MONTHLY SALES CHART (last 12 months)
    const monthlyStats = await Order.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          totalOrders: { $sum: 1 },
          totalSales: { $sum: "$totalAmount" },
        },
      },
      { $sort: { "_id": 1 } },
    ]);

    const monthlyData = Array(12).fill({ orders: 0, sales: 0 });

    monthlyStats.forEach((stat) => {
      const monthIndex = stat._id - 1;
      monthlyData[monthIndex] = {
        orders: stat.totalOrders,
        sales: stat.totalSales,
      };
    });

    // ✅ QUICK STATS
    const averageOrderValue =
      totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const conversionRate = 3.2; // placeholder
    const satisfaction = 94; // placeholder

    return res.json({
      totals: {
        totalRevenue,
        totalOrders,
        totalProducts,
        totalCustomers,
      },
      growth: {
        revenueGrowth,
        orderGrowth,
        productGrowth,
        customerGrowth,
      },
      monthlyData,
      quickStats: {
        averageOrderValue,
        conversionRate,
        satisfaction,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to fetch dashboard stats" });
  }
};