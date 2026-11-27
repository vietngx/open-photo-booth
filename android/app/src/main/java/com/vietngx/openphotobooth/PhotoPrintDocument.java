package com.vietngx.openphotobooth;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintJob;
import android.print.pdf.PrintedPdfDocument;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

final class PhotoPrintDocument extends PrintDocumentAdapter {
    private final Context context;
    private final Uri photo;
    private final PrintDocumentInfo info;
    private final PluginCall call;
    private PrintAttributes attributes;
    private boolean previewOnly = true;
    PrintJob job;

    PhotoPrintDocument(Context context, Uri photo, String name, PluginCall call) {
        this.context = context;
        this.photo = photo;
        this.call = call;
        String documentName = name.replaceFirst("(?i)\\.jpe?g$", "") + ".pdf";
        info = new PrintDocumentInfo.Builder(documentName).setPageCount(1).setContentType(PrintDocumentInfo.CONTENT_TYPE_PHOTO).build();
    }

    @Override
    public void onLayout(PrintAttributes old, PrintAttributes next, CancellationSignal cancel, LayoutResultCallback result, Bundle extras) {
        if (cancel.isCanceled()) result.onLayoutCancelled();
        else {
            attributes = next;
            // Android can finish the adapter before it updates the print job's state.
            previewOnly = extras.getBoolean(EXTRA_PRINT_PREVIEW, true);
            result.onLayoutFinished(info, !next.equals(old));
        }
    }

    private Bitmap readPhoto() throws IOException {
        // A full camera frame can exceed the print spooler's bitmap budget.
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        try (InputStream input = context.getContentResolver().openInputStream(photo)) {
            BitmapFactory.decodeStream(input, null, options);
        }
        options.inJustDecodeBounds = false;
        options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 4096) options.inSampleSize *= 2;
        try (InputStream input = context.getContentResolver().openInputStream(photo)) {
            Bitmap bitmap = BitmapFactory.decodeStream(input, null, options);
            if (bitmap == null) throw new IOException("Could not read the saved photo.");
            return bitmap;
        }
    }

    @Override
    public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancel, WriteResultCallback result) {
        new Thread(() -> {
            try (OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(destination)) {
                if (!cancel.isCanceled()) writePage(output, cancel);
            } catch (Exception e) {
                if (cancel.isCanceled()) result.onWriteCancelled();
                else result.onWriteFailed(e.getMessage());
                return;
            }
            if (cancel.isCanceled()) result.onWriteCancelled();
            else result.onWriteFinished(new PageRange[] { new PageRange(0, 0) });
        }, "Booth photo print").start();
    }

    private void writePage(OutputStream output, CancellationSignal cancel) throws IOException {
        Bitmap image = readPhoto();
        PrintedPdfDocument document = new PrintedPdfDocument(context, attributes);
        try {
            PdfDocument.Page page = document.startPage(0);
            try {
                Rect area = document.getPageContentRect();
                float scale = Math.min((float) area.width() / image.getWidth(), (float) area.height() / image.getHeight());
                float width = image.getWidth() * scale, height = image.getHeight() * scale;
                float x = (area.width() - width) / 2, y = (area.height() - height) / 2;
                page.getCanvas().drawBitmap(image, null, new RectF(x, y, x + width, y + height), new Paint(Paint.FILTER_BITMAP_FLAG));
            } finally {
                document.finishPage(page);
            }
            if (!cancel.isCanceled()) document.writeTo(output);
        } finally {
            document.close();
            image.recycle();
        }
    }

    @Override
    public void onFinish() {
        if (job != null && job.isFailed()) call.reject("Android reported a print failure.");
        else call.resolve(new JSObject().put("cancelled", previewOnly || (job != null && job.isCancelled())));
    }
}
