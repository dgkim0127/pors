package com.piercingpos.app;

import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().setStatusBarColor(Color.rgb(246, 242, 232));
        getWindow().setNavigationBarColor(Color.rgb(246, 242, 232));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new NativePrintBridge(), "PorsPrint");
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    finish();
                    return;
                }
                webView.evaluateJavascript("(window.PorsHandleBack && window.PorsHandleBack()) ? true : false;", result -> {
                    if (!"true".equals(result)) {
                        finish();
                    }
                });
            }
        });
    }

    private class NativePrintBridge {
        @JavascriptInterface
        public void print() {
            runOnUiThread(() -> {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) return;
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                if (printManager == null) return;
                String jobName = "PORS Receipt";
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                PrintAttributes attributes = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4.asLandscape())
                        .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build();
                printManager.print(jobName, adapter, attributes);
            });
        }
    }
}
