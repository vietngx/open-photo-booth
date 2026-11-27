package com.vietngx.openphotobooth;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BoothInstallationTest {

    @Test
    public void bundlesMobileAdapterAndTemplate() throws Exception {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (String asset : new String[] { "public/booth-mobile.js", "public/templates/classic-strip/template.xml" }) {
            try (InputStream stream = appContext.getAssets().open(asset)) {
                assertTrue(asset, stream.read() >= 0);
            }
        }
    }
}
