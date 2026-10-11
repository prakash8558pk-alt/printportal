import multer from 'multer';
const allowed = new Set(['application/pdf','image/jpeg','image/png','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const upload = multer({ storage: multer.memoryStorage(), limits: {fileSize: 5*1024*1024, files:1, fields:10}, fileFilter: (req,file,cb) => cb(allowed.has(file.mimetype) ? null : new Error('Only PDF, JPG, PNG, WebP, text and DOCX files supported'),allowed.has(file.mimetype)) });
export const handleUpload = (req,res,next) => upload.single('file')(req,res,err => err ? res.status(400).json({success:false,message:err.code==='LIMIT_FILE_SIZE'?'File must be 5MB or smaller':err.message}) : next());
