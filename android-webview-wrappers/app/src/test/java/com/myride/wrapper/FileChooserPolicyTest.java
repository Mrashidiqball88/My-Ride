package com.myride.wrapper;

import org.junit.Test;
import static org.junit.Assert.*;

public final class FileChooserPolicyTest {
    private FileChooserPolicy policy(String[] accept, boolean capture, boolean multiple) {
        return new FileChooserPolicy(accept, capture, multiple, extension -> {
            if ("jpg".equals(extension) || "jpeg".equals(extension)) return "image/jpeg";
            if ("png".equals(extension)) return "image/png";
            return null;
        });
    }

    @Test public void explicitImageCaptureUsesCameraAndSingleOutput() {
        FileChooserPolicy result = policy(new String[]{"image/*"}, true, true);
        assertTrue(result.captureImage);
        assertFalse(result.allowMultiple);
    }

    @Test public void imageInputWithoutCaptureUsesGallery() {
        FileChooserPolicy result = policy(new String[]{"image/*"}, false, false);
        assertFalse(result.captureImage);
        assertFalse(result.allowMultiple);
        assertEquals("image/*", result.pickerType);
    }

    @Test public void galleryMultipleOnlyWhenRequested() {
        assertTrue(policy(new String[]{"image/*"}, false, true).allowMultiple);
        assertFalse(policy(new String[]{"image/*"}, false, false).allowMultiple);
    }

    @Test public void exactMimeFiltersArePreserved() {
        FileChooserPolicy result = policy(new String[]{"image/jpeg", "image/png"}, false, true);
        assertArrayEquals(new String[]{"image/jpeg", "image/png"}, result.mimeTypes);
        assertEquals("image/*", result.pickerType);
    }

    @Test public void commaSeparatedExtensionsAreNormalizedAndDeduplicated() {
        FileChooserPolicy result = policy(new String[]{" .JPG, .png, image/jpeg "}, true, false);
        assertArrayEquals(new String[]{"image/jpeg", "image/png"}, result.mimeTypes);
        assertTrue(result.captureImage);
    }

    @Test public void mixedMediaCaptureDoesNotLaunchImageCamera() {
        FileChooserPolicy result = policy(new String[]{"image/*", "video/*"}, true, true);
        assertFalse(result.captureImage);
        assertEquals("*/*", result.pickerType);
        assertTrue(result.allowMultiple);
    }

    @Test public void nonImageCaptureDoesNotLaunchImageCamera() {
        assertFalse(policy(new String[]{"video/*"}, true, false).captureImage);
        assertFalse(policy(new String[]{"application/pdf"}, true, false).captureImage);
    }

    @Test public void emptyAndInvalidAcceptRetainGeneralFilePicker() {
        for (String[] accept : new String[][]{null, {}, {""}, {null, ".unknown", "invalid"}}) {
            FileChooserPolicy result = policy(accept, true, false);
            assertEquals("*/*", result.pickerType);
            assertFalse(result.captureImage);
        }
    }

    @Test public void wildcardOverridesNarrowFilters() {
        FileChooserPolicy result = policy(new String[]{"image/png", "*/*"}, true, false);
        assertArrayEquals(new String[]{"*/*"}, result.mimeTypes);
        assertFalse(result.captureImage);
    }
}