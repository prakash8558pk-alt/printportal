import PrintRequest from "../models/PrintRequest.js";
import { getIO } from "../config/socket.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import fs from "fs";
import path from "path";
import { db } from "../config/turso.js";
import { randomUUID } from "node:crypto";

/* ----------------------------------------
   CREATE PRINT REQUEST (Employee)
----------------------------------------- */
export const createPrintRequest = asyncHandler(async (req, res) => {
    const { title, copies, printType, deliveryType, deliveryRoom, dueDateTime } = req.body;

    if (!req.file) {
        throw new ApiError(400, "File is required");
    }

    if (!title || title.length>200 || !Number.isInteger(Number(copies)) || Number(copies)<1 || Number(copies)>1000 || !['SINGLE_SIDE','DOUBLE_SIDE'].includes(printType) || !['PICKUP','ROOM_DELIVERY'].includes(deliveryType) || !dueDateTime || Number.isNaN(Date.parse(dueDateTime))) {
        // Clean up uploaded file if validation fails
        if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        throw new ApiError(400, "Missing required fields");
    }

    const fileId = randomUUID();
    const newRequest = await PrintRequest.create({
        employee: req.user.userId,
        organization: req.user.organizationId,
        title,
        fileUrl: fileId,
        cloudinaryId: null,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        originalName: req.file.originalname,
        copies,
        printType,
        deliveryType,
        deliveryRoom,
        dueDateTime: new Date(dueDateTime),
    });

    try {
      await db.execute({sql:'INSERT INTO print_files(id,organization,employee,mime,name,content) VALUES (?,?,?,?,?,?)',args:[fileId,req.user.organizationId,req.user.userId,req.file.mimetype,req.file.originalname,req.file.buffer]});
    } catch (err) { await newRequest.deleteOne(); throw err; }
    res.status(201).json({
        success: true,
        message: "Print request created successfully",
        request: newRequest,
    });
});

/* ----------------------------------------
   GET ALL PRINT REQUESTS
----------------------------------------- */
export const getPrintRequests = asyncHandler(async (req, res) => {
    const { role, userId } = req.user;
    const { status, page = 1, limit = 10 } = req.query;

    const query = {
        organization: req.user.organizationId,
    };

    if (role === "EMPLOYEE") {
        query.employee = userId;
    }

    if (role === 'PRINTING') query.status = { $in: ['APPROVED', 'IN_PROGRESS', 'COMPLETED'] };
    if (status) {
      if (!['PENDING','APPROVED','REJECTED','IN_PROGRESS','COMPLETED'].includes(status)) throw new ApiError(400,'Invalid status');
      if (role === 'PRINTING' && !['APPROVED','IN_PROGRESS','COMPLETED'].includes(status)) throw new ApiError(403,'Denied');
      query.status = status;
    }

    const skip = (page - 1) * limit;

    const requests = await PrintRequest.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("employee", "name email");

    const total = await PrintRequest.countDocuments(query);

    res.json({
        success: true,
        data: requests,
        pagination: {
            total,
            page: parseInt(page),
            pages: Math.ceil(total / limit),
        },
    });
});

/* ----------------------------------------
   GET SINGLE PRINT REQUEST
----------------------------------------- */
export const getPrintRequestById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role, userId } = req.user;

    const request = await PrintRequest.findById(id).populate("employee", "name email");

    if (!request) throw new ApiError(404, "Print request not found");

    if (request.organization.toString() !== req.user.organizationId) {
        throw new ApiError(403, "Access denied");
    }

    let canAccess = false;
    if (role === "ADMIN" || role === "PRINTING") canAccess = true;
    else if (role === "EMPLOYEE" && request.employee._id.toString() === userId) canAccess = true;

    if (!canAccess) throw new ApiError(403, "Access denied");

    res.json({ success: true, request });
});

/* ----------------------------------------
   APPROVE PRINT REQUEST (Admin)
----------------------------------------- */
export const approvePrintRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const request = await PrintRequest.findById(id);
    if (!request) throw new ApiError(404, "Print request not found");
    if (request.organization.toString() !== req.user.organizationId) throw new ApiError(403, "Access denied");

    request.status = "APPROVED";
    await request.save();

    const io = getIO();
    io.to(req.user.organizationId).emit("notify_employee", {
        type: "APPROVED",
        requestId: request._id,
        message: "Your print request has been approved",
    });

    // Notify Printing Dept
    io.to(req.user.organizationId).emit("notify_printing", {
        type: "NEW_JOB",
        requestId: request._id,
        message: "A new print request is ready for processing",
    });

    res.json({ success: true, message: "Print request approved", request });
});

/* ----------------------------------------
   REJECT PRINT REQUEST (Admin)
----------------------------------------- */
export const rejectPrintRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const request = await PrintRequest.findById(id);
    if (!request) throw new ApiError(404, "Print request not found");
    if (request.organization.toString() !== req.user.organizationId) throw new ApiError(403, "Access denied");

    request.status = "REJECTED";
    await request.save();

    const io = getIO();
    io.to(req.user.organizationId).emit("notify_employee", {
        type: "REJECTED",
        requestId: request._id,
        message: "Your print request has been rejected",
    });

    res.json({ success: true, message: "Print request rejected", request });
});

/* ----------------------------------------
   UPDATE STATUS (Printing Department)
----------------------------------------- */
export const updatePrintStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const { role } = req.user;

    if (role !== "ADMIN" && role !== "PRINTING") throw new ApiError(403, "Not authorized");

    const request = await PrintRequest.findById(id);
    if (!request) throw new ApiError(404, "Print request not found");
    if (request.organization.toString() !== req.user.organizationId) throw new ApiError(403, "Access denied");

    const allowed = { APPROVED: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED' };
    if (allowed[request.status] !== status) throw new ApiError(400, 'Invalid status transition');
    request.status = status;
    await request.save();

    const io = getIO();
    io.to(req.user.organizationId).emit("notify_employee", {
        type: "STATUS_UPDATE",
        requestId: request._id,
        status: request.status,
        message: `Your print request status is now: ${status}`,
    });

    res.json({ success: true, message: `Print request status updated to ${status}`, request });
});

/* ----------------------------------------
   GET PREVIEW URL / SERVE FILE MAPPER
----------------------------------------- */
export const getPrintFileSignedUrl = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role, userId } = req.user;

    const request = await PrintRequest.findById(id);
    if (!request) throw new ApiError(404, "Print request not found");

    if (request.organization.toString() !== req.user.organizationId) {
        throw new ApiError(403, "Access denied");
    }

    let canAccess = false;
    if (role === "ADMIN" || role === "PRINTING") canAccess = true;
    else if (role === "EMPLOYEE" && request.employee.toString() === userId) canAccess = true;

    if (!canAccess) throw new ApiError(403, "Access denied");

    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const fileServeUrl = `${serverUrl}/api/print-requests/${id}/file`;

    return res.json({ success: true, url: fileServeUrl });
});

/* ----------------------------------------
   SERVE FILE CONTENT (Stream)
----------------------------------------- */
async function sendFile(req,res,download) {
 const request = await PrintRequest.findById(req.params.id);
 if (!request || request.organization !== req.user.organizationId) throw new ApiError(404,'File not found');
 if (req.user.role === 'EMPLOYEE' && request.employee !== req.user.userId) throw new ApiError(403,'Denied');
 if (req.user.role === 'PRINTING' && !['APPROVED','IN_PROGRESS','COMPLETED'].includes(request.status)) throw new ApiError(403,'Denied');
 if (download && req.query.json === 'true') return res.json({success:true, useStream:true});
 const result = await db.execute({sql:'SELECT mime,name,content FROM print_files WHERE id=? AND organization=?',args:[request.fileUrl,req.user.organizationId]});
 const file = result.rows[0]; if (!file) throw new ApiError(404,'File missing');
 const safeName = String(file.name).replace(/[^a-zA-Z0-9_.-]/g,'_');
 res.set('Content-Type',file.mime); res.set('Cache-Control','private, no-store'); res.set('Content-Disposition',`${download?'attachment':'inline'}; filename="${safeName}"`);
 res.send(Buffer.from(file.content));
}
export const servePrintFile = asyncHandler((req,res)=>sendFile(req,res,false));
export const downloadPrintFile = asyncHandler((req,res)=>sendFile(req,res,true));

export const deletePrintRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role, userId } = req.user;

    const request = await PrintRequest.findById(id);
    if (!request) throw new ApiError(404, "Print request not found");

    if (request.organization.toString() !== req.user.organizationId) throw new ApiError(403, "Access denied");

    let canDelete = false;
    if (role === "ADMIN") canDelete = true;
    else if (role === "EMPLOYEE" && request.employee.toString() === userId) {
        if (["PENDING", "REJECTED", "COMPLETED"].includes(request.status)) canDelete = true;
    }

    if (!canDelete) throw new ApiError(403, "Not authorized to delete this request");

    // Delete from Cloudinary if it exists
    await db.execute({sql:'DELETE FROM print_files WHERE id=? AND organization=?',args:[request.fileUrl,req.user.organizationId]});

    await request.deleteOne();

    res.json({
        success: true,
        message: "Print request deleted successfully"
    });
});
