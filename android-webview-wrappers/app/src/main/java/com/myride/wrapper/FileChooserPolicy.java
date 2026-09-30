package com.myride.wrapper;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** Pure chooser policy, shared by both flavors and independently testable. */
final class FileChooserPolicy {
    interface ExtensionMimeTypeResolver {
        String resolve(String extension);
    }

    final String[] mimeTypes;
    final String pickerType;
    final boolean captureImage;
    final boolean allowMultiple;

    FileChooserPolicy(String[] acceptTypes, boolean captureEnabled, boolean multiple,
            ExtensionMimeTypeResolver extensionMimeType) {
        Set<String> types = new LinkedHashSet<>();
        if (acceptTypes != null) {
            for (String accept : acceptTypes) {
                if (accept == null) {
                    continue;
                }
                // Some WebViews supply the HTML accept list as a single comma-separated value.
                for (String part : accept.split(",")) {
                    String type = part.trim().toLowerCase(Locale.ROOT);
                    if (type.startsWith(".")) {
                        type = extensionMimeType.resolve(type.substring(1));
                    }
                    if (type != null && type.matches("(\\*|[a-z0-9!#$&^_.+-]+)/(\\*|[a-z0-9!#$&^_.+-]+)")) {
                        types.add(type);
                    }
                }
            }
        }
        if (types.isEmpty() || types.contains("*/*")) {
            types.clear();
            types.add("*/*");
        }
        mimeTypes = types.toArray(new String[0]);
        boolean imagesOnly = true;
        String commonFamily = mimeTypes[0].split("/")[0];
        for (String type : mimeTypes) {
            imagesOnly &= type.startsWith("image/");
            if (!type.startsWith(commonFamily + "/")) {
                commonFamily = "*";
            }
        }
        pickerType = mimeTypes.length == 1 ? mimeTypes[0] : commonFamily + "/*";
        captureImage = captureEnabled && imagesOnly;
        allowMultiple = multiple && !captureImage;
    }
}