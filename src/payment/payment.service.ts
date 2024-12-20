//paymernt service
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PAYMENT_METHOD, PAYMENT_STATUS, Prisma } from '@prisma/client';
import { CourtService } from 'src/court/court.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentDto } from './dto/payment.dto';
import { PImageDto } from './dto/p_image.dto';
import { BookingService } from 'src/booking/booking.service';
import { PaymentHandlerDto } from './dto/paymenthandler.dto';
import { UploadService } from 'src/upload/upload.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingService: BookingService,
    private readonly uploadService: UploadService,
  ) {}

  async paymentHandler(dto: PaymentHandlerDto): Promise<boolean> {
    const { total_amount, paid_amount, min_down_payment, payment_amount } = dto;
    // Calculate remaining and threshold amounts
    const remainingAmount = total_amount - paid_amount;
    const thresholdAmount = (min_down_payment * total_amount) / 100;

    if (paid_amount >= total_amount) {
      console.error('Payment is already completed for this booking');
      return false;
    }

    if (remainingAmount === total_amount && payment_amount < thresholdAmount) {
      console.error(
        `First payment must meet the minimum threshold: ${thresholdAmount}`,
      );
      return false;
    }

    // if (payment_amount > remainingAmount) {
    //   console.error(`Payment exceeds the remaining amount: ${remainingAmount}`);
    //   return false;
    // }
    return true;
  }

  async createPayment(dto: PaymentDto) {
    const { booking_id, payment_amount, payment_method } = dto;
    try {
      const bookingDetails =
        await this.bookingService.getBookingDetails(booking_id);

      const { total_amount, paid_amount } = bookingDetails;
      const { min_down_payment } = bookingDetails.slot.court;

      const pendingPayments = bookingDetails.payment.find(
        (payment) =>
          payment.payment_status === 'verification_pending' ||
          payment.payment_status === 'not_paid',
      );

      if (pendingPayments) {
        throw new ConflictException(
          'A payment is already pending for this booking',
        );
      }

      const paymentHandlerDto = {
        total_amount,
        paid_amount,
        min_down_payment,
        payment_amount,
      };
      const isValid = await this.paymentHandler(paymentHandlerDto);
      if (isValid === false) {
        throw new BadRequestException(
          'Something Wrong with the Payment Amount',
        );
      }

      // Create the payment record
      return await this.prisma.payment.create({
        data: {
          booking_id,
          payment_amount,
          payment_status: 'not_paid',
          payment_method: payment_method as PAYMENT_METHOD,
          payment_image_link: '',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new InternalServerErrorException(
          'Database error occurred while creating payment',
        );
      }
      throw new InternalServerErrorException(
        'Failed to create payment',
        error.message,
      );
    }
  }

  async updatePayment(id: string, dto: PaymentDto) {
    const { payment_amount, payment_method, booking_id } = dto;
    // const payment = this.prisma.payment.update({ where: { id }, data: { payment_amount, payment_method } });

    try {
      const payment = await this.getPaymentById(id);
      if (payment.payment_status === 'paid') {
        throw new ConflictException('Paid Payment cannot be updated');
      }
      const bookingDetails =
        await this.bookingService.getBookingDetails(booking_id);

      const { total_amount, paid_amount } = bookingDetails;
      const { min_down_payment } = bookingDetails.slot.court;

      const paymentHandlerDto = {
        total_amount,
        paid_amount,
        min_down_payment,
        payment_amount,
      };

      if (!this.paymentHandler(paymentHandlerDto)) {
        throw new ConflictException('Something Wrong with the Payment Amount');
      }

      // Update the payment record
      return await this.prisma.payment.update({
        where: { id },
        data: {
          payment_amount,
          payment_method: payment_method as PAYMENT_METHOD,
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to update payment',
        error.message,
      );
    }
  }

  async getPayments() {
    try {
      return await this.prisma.payment.findMany();
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to fetch payments',
        error.message,
      );
    }
  }

  getPaymentByStatus(status: PAYMENT_STATUS) {
    try {
      const payments = this.prisma.payment.findMany({
        where: { payment_status: status as PAYMENT_STATUS },
      });
      return payments;
    } catch (error) {
      throw new InternalServerErrorException("Failed to fetch payments by status", error.message);
    }
  }

  async getPaymentById(id: string) {
    try {
      const payment= await this.prisma.payment.findFirst(
        { 
        where: { id },
        include: { booking: {
          include: { user: true }
        } } 
      },);

      if (!payment) {
        throw new NotFoundException('Payment not found');
        }
        if (payment.payment_image_link) {
          payment.payment_image_link = await this.uploadService.getFileUrl(payment.payment_image_link);
        }
        return payment;
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to fetch payment by id',
        error.message,
      );
    }
  }

  async uploadPaymentImage(token : any , image: Express.Multer.File , paymentId: PImageDto) {

    try {
      const { payment_id } = paymentId;
      const { userId } = token;
      const payment = await this.getPaymentById(payment_id);
      if (!payment) {
        throw new NotFoundException(`Payment with ID ${payment_id} not found`);
      }
      if (payment.booking.user_id !== userId) {
        throw new BadRequestException('You are not authorized to upload payment image for this booking');
      }
      const upload_result =  await this.uploadService.uploadFile(image);
      const {filename} = upload_result;

      const updatedPayment = await this.prisma.payment.update({
        where: { id: payment_id },
        data: { payment_image_link: filename,
          payment_status: 'verification_pending'
         },
      });

      return updatedPayment;
    } catch (error) {
      throw new Error(
      error
      );
    }
  }

  async verifyPayment(id: string) {
    console.log('Verifying payment:', id);
    if (!id) {
      throw new BadRequestException('Payment ID is required');
    }

    try {
      return await this.prisma.$transaction(async (prisma) => {
        // Step 1: Fetch the payment and validate its current status
        //verify if the paymne exists
        const payment = await this.getPaymentById(id);
        if (!payment) {
          throw new NotFoundException(`Payment with ID ${id} not found`);
        }

        if (payment.payment_status === 'paid') {
          throw new ConflictException('This payment has already been verified');
        }

        // Step 2: Update payment status to 'paid'
        const updatedPayment = await prisma.payment.update({
          where: { id },
          data: { payment_status: 'paid' },
        });

        console.log('Payment verified successfully:', updatedPayment);

        // Step 3: Fetch and update booking details
        const booking = await prisma.booking.update({
          where: { id: updatedPayment.booking_id },
          data: {
            paid_amount: { increment: updatedPayment.payment_amount },
          },
          include: {
            slot: {
              include: {
                court: true,
              },
            },
          },
        });

        if (!booking) {
          throw new InternalServerErrorException(
            `Failed to update booking for payment ID ${id}`,
          );
        }

        // Step 4: Calculate minimum down payment and determine booking status
        const { total_amount, paid_amount, status, slot } = booking;
        const minDownPayment =
          (slot.court.min_down_payment * total_amount) / 100;

        let updatedStatus = null;

        if (paid_amount >= total_amount && status !== 'completed') {
          updatedStatus = 'completed'; // Fully paid
        } else if (paid_amount >= minDownPayment && status !== 'confirmed') {
          updatedStatus = 'confirmed'; // Partially paid beyond threshold
        }

        // Step 5: Update booking status if necessary
        if (updatedStatus) {
          await prisma.booking.update({
            where: { id: booking.id },
            data: { status: updatedStatus },
          });

          console.log(`Booking status updated to '${updatedStatus}'`);
          booking.status = updatedStatus;
        }

        // Return the updated payment and booking
        return {
          message: 'Payment verified successfully',
          payment: updatedPayment,
          booking,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new InternalServerErrorException(
          'A database error occurred while verifying payment',
        );
      }
      throw new InternalServerErrorException(
        'Failed to verify payment',
        error.message,
      );
    }
  }

  deletePayment(id: any) {
    throw new Error('Method not implemented.');
  }
}
