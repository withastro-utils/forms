import fsExtra from "fs-extra/esm";
import fs from "fs/promises";
import oldFs from "fs";
import path from "path";
import z from "zod";
import os from "os";
import { validateFrom } from "../../../form-tools/csrf.js";
import { AstroGlobal } from "astro";
import { getFormValue } from "../../../form-tools/post.js";

const zodValidationInfo =
    z.preprocess((str: any, ctx) => {
        try {
            return JSON.parse(str);
        } catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid JSON",
            });
            return z.NEVER;
        }
    }, z.object({
        uploadId: z.string().uuid(),
        uploadSize: z.number().min(1),
        part: z.number().min(1),
        total: z.number().min(1),
    }));

export type LoadUploadFilesOptions = {
    allowUpload?: (file: File, info: z.infer<typeof zodValidationInfo>) => boolean | Promise<boolean>;
    onFinished?: (fileId: string, totalSize: number) => void | Promise<void>;
    maxUploadTime?: number;
    maxUploadSize?: number;
    maxDirectorySize?: number;
    tempDirectory: string;
};

export const DEFAULT_BIG_FILE_UPLOAD_OPTIONS_SERVER: LoadUploadFilesOptions = {
    maxUploadTime: 1000 * 60 * 60 * 1.5, // 1.5 hour
    maxUploadSize: 1024 * 1024 * 1024, // 1GB
    maxDirectorySize: 1024 * 1024 * 1024 * 50, // 50GB
    tempDirectory: path.join(os.tmpdir(), "astro_forms_big_files_uploads"),
};

export async function loadUploadFiles(astro: AstroGlobal, options: Partial<LoadUploadFilesOptions> = {}) {
    const { allowUpload, onFinished, maxUploadTime, maxUploadSize, maxDirectorySize, tempDirectory } = { ...DEFAULT_BIG_FILE_UPLOAD_OPTIONS_SERVER, ...options };
    if (astro.request.method !== "POST" || !await validateFrom(astro)) {
        return false;
    }

    if (await getFormValue(astro.request, "astroBigFileUpload") !== "true") {
        return false;
    }

    await fsExtra.ensureDir(tempDirectory);
    await deleteOldUploads(tempDirectory, maxUploadTime);
    const uploadInfo = await getFormValue(astro.request, "info");
    const uploadFileMayBe = await getFormValue(astro.request, "file");

    const { data, success } = zodValidationInfo.safeParse(uploadInfo);
    if (!success || uploadFileMayBe instanceof File === false) {
        return Response.json({ ok: false, error: "Invalid request" });
    }
    const uploadFile = uploadFileMayBe as File;

    const { uploadId, uploadSize, part, total } = data;

    const uploadDir = path.join(tempDirectory, 'chunks_' + uploadId);
    await fsExtra.ensureDir(uploadDir);

    const sendError = async (errorMessage: string) => {
        await fs.writeFile(path.join(uploadDir, 'error.txt'), errorMessage);
        return Response.json({ ok: false, error: errorMessage });
    };

    if (typeof allowUpload === "function") {
        if (!await allowUpload(uploadFile, data)) {
            return await sendError("File not allowed");
        }
    }

    if (uploadSize > maxUploadSize) {
        return await sendError("File size exceeded");
    }

    const totalDirectorySizeWithNewUpload = (await totalDirectorySize(tempDirectory)) + Math.max(uploadSize, uploadFile.size);
    if (totalDirectorySizeWithNewUpload > maxDirectorySize) {
        return await sendError("Directory size exceeded");
    }

    const newTotalSize = (await totalDirectorySize(tempDirectory)) + uploadSize;
    if (newTotalSize > maxUploadSize) {
        await fsExtra.remove(uploadDir);
        return await sendError("Upload size exceeded");
    }

    const uploadFilePath = path.join(tempDirectory, uploadId);
    if (await checkIfFileExists(uploadFilePath)) {
        return await sendError("Upload already exists");
    }


    const chunkSavePath = path.join(uploadDir, `${part}-${total}`);
    if (!await checkIfFileExists(chunkSavePath)) {
        await fs.writeFile(chunkSavePath, uploadFile.stream() as any);
    }

    if (part !== total) {
        return Response.json({ ok: true });
    }

    const files = await fs.readdir(uploadDir);
    for (let i = 1; i <= total; i++) {
        if (!files.includes(`${i}-${total}`)) {
            return await sendError(`Missing chunk ${i}, upload failed`);
        }
    }

    const outputStream = oldFs.createWriteStream(uploadFilePath, { flags: 'a' });
    for (const file of files) {
        const fileFullPath = path.join(uploadDir, file);
        const inputStream = oldFs.createReadStream(fileFullPath);
        await new Promise((resolve, reject) => {
            inputStream.on("data", (chunk) => {
                outputStream.write(chunk);
            });
            inputStream.on("end", resolve);
            inputStream.on("error", reject);
        });
        await fsExtra.remove(fileFullPath);
    }
    await fsExtra.remove(uploadDir);

    await onFinished?.(uploadId, files.length);
    return Response.json({ ok: true, finished: true });
}

async function deleteOldUploads(tempDirectory: string, maxUploadTime: number) {
    const files = await fs.readdir(tempDirectory);
    for (const file of files) {
        const fullPath = path.join(tempDirectory, file);
        const stat = await fs.stat(fullPath);
        if (Date.now() - stat.mtime.getTime() > maxUploadTime) {
            await fsExtra.remove(fullPath);
        }
    }
}

async function totalDirectorySize(directory: string) {
    const files = await fs.readdir(directory);
    let totalSize = 0;

    const promises = [];
    for (const file of files) {
        const fullPath = path.join(directory, file);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            promises.push(totalDirectorySize(fullPath));
        } else {
            totalSize += stat.size;
        }
    }

    totalSize += (await Promise.all(promises)).reduce((a, b) => a + b, 0);
    return totalSize;
}

export async function checkIfFileExists(filePath: string) {
    try {
        const file = await fs.stat(filePath);
        return file.isFile();
    } catch {
        return false;
    }
}