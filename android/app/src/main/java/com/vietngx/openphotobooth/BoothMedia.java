package com.vietngx.openphotobooth;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;

@CapacitorPlugin(name = "BoothMedia", permissions = {
    @Permission(alias = "legacyPictures", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
})
public class BoothMedia extends Plugin {
    private static final Uri IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    private static final String ALBUM = "Open Photo Booth";
    private static final String PICTURES = Environment.DIRECTORY_PICTURES + "/" + ALBUM + "/";

    @PluginMethod
    public void savePhoto(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("legacyPictures") != PermissionState.GRANTED) {
            requestPermissionForAlias("legacyPictures", call, "storagePermissionResult");
            return;
        }
        save(call);
    }

    @PermissionCallback
    private void storagePermissionResult(PluginCall call) {
        if (getPermissionState("legacyPictures") == PermissionState.GRANTED) {
            getBridge().execute(() -> save(call));
        } else {
            call.reject("Allow storage access to save photos to Pictures.");
        }
    }

    private void save(PluginCall call) {
        Uri photo = null;
        ContentResolver resolver = getContext().getContentResolver();
        try {
            String name = call.getString("name", "");
            if (!name.matches("[a-zA-Z0-9][a-zA-Z0-9._ -]*\\.jpg")) throw new IOException("Invalid photo name.");
            byte[] jpeg = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            if (jpeg.length < 3 || jpeg[0] != (byte) 0xff || jpeg[1] != (byte) 0xd8 || jpeg[2] != (byte) 0xff) {
                throw new IOException("Expected a JPEG photo.");
            }
            String event = call.getString("eventName", "").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
            if (event.isEmpty() || event.matches("\\.+")) event = "Event";
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH, PICTURES + event + "/");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            } else {
                File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM + "/" + event);
                if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("Could not create the event folder.");
                File target = new File(directory, name);
                for (int copy = 2; target.exists(); copy++) {
                    target = new File(directory, name.substring(0, name.length() - 4) + "-" + copy + ".jpg");
                }
                values.put(MediaStore.Images.Media.DATA, target.getAbsolutePath());
            }
            photo = resolver.insert(IMAGES, values);
            if (photo == null) throw new IOException("Could not create the photo in Pictures.");
            try (OutputStream output = resolver.openOutputStream(photo)) {
                if (output == null) throw new IOException("Could not open the photo for writing.");
                output.write(jpeg);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                if (resolver.update(photo, values, null, null) != 1) throw new IOException("Could not publish the photo.");
            }
            call.resolve(new JSObject().put("file", photo.toString()));
        } catch (Exception e) {
            try {
                if (photo != null) resolver.delete(photo, null, null);
            } catch (RuntimeException cleanupError) {
                e.addSuppressed(cleanupError);
            }
            call.reject("Could not save photo: " + e.getMessage(), e);
        }
    }

    private String photoName(Uri photo) throws IOException {
        if (!ContentUris.withAppendedId(IMAGES, ContentUris.parseId(photo)).equals(photo)) throw new IOException("Invalid photo.");
        boolean scoped = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String location = scoped ? MediaStore.Images.Media.RELATIVE_PATH : MediaStore.Images.Media.DATA;
        String prefix = scoped ? PICTURES : new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM) + "/";
        String[] columns = { MediaStore.Images.Media.DISPLAY_NAME, location };
        try (Cursor row = getContext().getContentResolver().query(photo, columns, null, null, null)) {
            if (row == null || !row.moveToFirst() || row.isNull(1) || !row.getString(1).startsWith(prefix)) {
                throw new IOException("Photo is not in the booth album.");
            }
            return row.getString(0);
        }
    }

    @PluginMethod
    public void printPhoto(PluginCall call) {
        try {
            Uri photo = Uri.parse(call.getString("file", ""));
            String name = photoName(photo);
            int widthMils = (int) Math.round(call.getDouble("widthIn", 0d) * 1000);
            int heightMils = (int) Math.round(call.getDouble("heightIn", 0d) * 1000);
            PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(new PrintAttributes.MediaSize("BOOTH", "Photo", widthMils, heightMils))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                .build();
            getActivity().runOnUiThread(() -> {
                try {
                    PrintManager manager = getActivity().getSystemService(PrintManager.class);
                    PhotoPrintDocument document = new PhotoPrintDocument(getContext(), photo, name, call);
                    if (manager == null || (document.job = manager.print(name, document, attributes)) == null) {
                        call.reject("Printing is unavailable on this device.");
                    }
                } catch (RuntimeException e) {
                    call.reject("Could not start printing: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            call.reject("Could not print photo: " + e.getMessage(), e);
        }
    }
}
