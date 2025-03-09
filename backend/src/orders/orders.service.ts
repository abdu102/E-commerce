import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument, OrderStatus } from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { User } from '../users/schemas/user.schema';
import { ProductsService } from '../products/products.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    private productsService: ProductsService,
  ) {}

  async findAll(paginationDto: PaginationDto): Promise<{ orders: Order[]; total: number }> {
    const { page = 1, limit = 10 } = paginationDto;
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      this.orderModel
        .find()
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments().exec(),
    ]);

    return { orders, total };
  }

  async findByUser(userId: string): Promise<Order[]> {
    return this.orderModel
      .find({ user: userId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<Order> {
    const order = await this.orderModel
      .findById(id)
      .populate('user', 'name email')
      .populate('orderItems.product')
      .exec();
    
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    
    return order;
  }

  async create(user: User, createOrderDto: CreateOrderDto): Promise<Order> {
    const { orderItems, shippingAddress, paymentMethod } = createOrderDto;
    
    if (orderItems.length === 0) {
      throw new BadRequestException('No order items');
    }
    
    // Calculate prices
    let itemsPrice = 0;
    const orderItemsWithDetails = await Promise.all(
      orderItems.map(async item => {
        const product = await this.productsService.findById(item.product);
        
        if (product.stock < item.quantity) {
          throw new BadRequestException(`Product ${product.name} is out of stock`);
        }
        
        const price = product.discountPercentage > 0
          ? product.price * (1 - product.discountPercentage / 100)
          : product.price;
        
        itemsPrice += price * item.quantity;
        
        return {
          product: item.product,
          name: product.name,
          price,
          quantity: item.quantity,
          image: product.images && product.images.length > 0 ? product.images[0] : '',
        };
      }),
    );
    
    // Apply tax and shipping
    const taxPrice = itemsPrice * 0.15;
    const shippingPrice = itemsPrice > 100 ? 0 : 10;
    const totalPrice = itemsPrice + taxPrice + shippingPrice;
    
    // Create order
    const order = new this.orderModel({
      user: user._id,
      orderItems: orderItemsWithDetails,
      shippingAddress,
      paymentMethod,
      itemsPrice,
      taxPrice,
      shippingPrice,
      totalPrice,
    });
    
    const createdOrder = await order.save();
    
    // Update product stock
    await Promise.all(
      orderItems.map(item =>
        this.productsService.updateStock(item.product, item.quantity),
      ),
    );
    
    return createdOrder;
  }

  async updateStatus(id: string, updateOrderStatusDto: UpdateOrderStatusDto): Promise<Order> {
    const { status, trackingNumber } = updateOrderStatusDto;
    
    // Get the order document directly from the model
    const orderDocument = await this.orderModel.findById(id)
      .populate('user', 'name email')
      .populate('orderItems.product')
      .exec();
    
    if (!orderDocument) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    
    orderDocument.status = status;
    
    if (status === OrderStatus.DELIVERED) {
      orderDocument.isDelivered = true;
      orderDocument.deliveredAt = new Date();
    }
    
    if (trackingNumber) {
      orderDocument.trackingNumber = trackingNumber;
    }
    
    return orderDocument.save();
  }

  async markAsPaid(id: string): Promise<Order> {
    // Get the order document directly from the model
    const orderDocument = await this.orderModel.findById(id)
      .populate('user', 'name email')
      .populate('orderItems.product')
      .exec();
    
    if (!orderDocument) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    
    orderDocument.isPaid = true;
    orderDocument.paidAt = new Date();
    orderDocument.status = OrderStatus.PROCESSING;
    
    return orderDocument.save();
  }
}