package com.alimz.garagewidget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class WidgetConfigActivity : AppCompatActivity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }

        setContentView(R.layout.activity_config)

        val inputUrl = findViewById<EditText>(R.id.input_server_url)
        val inputToken = findViewById<EditText>(R.id.input_token)
        val btnSave = findViewById<Button>(R.id.btn_save)
        val textStatus = findViewById<TextView>(R.id.text_status)

        // Pre-fill saved values
        val prefs = getSharedPreferences("gw_$appWidgetId", MODE_PRIVATE)
        inputUrl.setText(prefs.getString("server_url", Constants.SERVER_URL))
        inputToken.setText(prefs.getString("token", ""))

        btnSave.setOnClickListener {
            val serverUrl = inputUrl.text.toString().trimEnd('/')
            val token = inputToken.text.toString().trim()

            if (serverUrl.isEmpty() || token.isEmpty()) {
                textStatus.text = "Please fill in both fields"
                return@setOnClickListener
            }

            btnSave.isEnabled = false
            textStatus.text = "Testing connection…"

            Thread {
                try {
                    val conn = URL("$serverUrl/api/widget/$token").openConnection() as HttpURLConnection
                    conn.connectTimeout = 10_000
                    conn.readTimeout = 10_000
                    val json = JSONObject(conn.inputStream.bufferedReader().readText())
                    conn.disconnect()
                    val carName = json.getString("car_name")
                    val km = json.getInt("current_km")

                    runOnUiThread {
                        // Save prefs
                        prefs.edit()
                            .putString("server_url", serverUrl)
                            .putString("token", token)
                            .apply()

                        textStatus.text = "Connected: $carName · ${"%,d".format(km)} km"

                        // Update the widget
                        val widgetMgr = AppWidgetManager.getInstance(this)
                        Thread { GarageWidget.updateWidget(this, widgetMgr, appWidgetId) }.start()

                        // Return OK so the home screen accepts the widget
                        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))

                        // Small delay so user sees the success message
                        window.decorView.postDelayed({ finish() }, 800)
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        btnSave.isEnabled = true
                        textStatus.text = "Failed: ${e.message?.take(80) ?: "Connection error"}. Check URL and token."
                    }
                }
            }.start()
        }
    }
}
