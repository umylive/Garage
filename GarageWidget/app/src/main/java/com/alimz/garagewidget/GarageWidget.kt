package com.alimz.garagewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.*
import android.net.Uri
import android.widget.RemoteViews
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class GarageWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) Thread { updateWidget(context, mgr, id) }.start()
    }

    companion object {

        fun updateWidget(context: Context, mgr: AppWidgetManager, id: Int) {
            val prefs = context.getSharedPreferences("gw_$id", Context.MODE_PRIVATE)
            val serverUrl = prefs.getString("server_url", "").orEmpty()
            val token = prefs.getString("token", "").orEmpty()
            val views = RemoteViews(context.packageName, R.layout.widget_layout)

            if (serverUrl.isEmpty() || token.isEmpty()) {
                views.setTextViewText(R.id.widget_car_name, "Tap to configure widget")
                views.setTextViewText(R.id.widget_make, "Long-press → Edit widget")
                views.setTextViewText(R.id.widget_odometer, "")
                views.setTextViewText(R.id.widget_status, "")
                mgr.updateAppWidget(id, views)
                return
            }

            try {
                val json = fetchJson("$serverUrl/api/widget/$token")

                val make = json.optString("car_make", "")
                val model = json.optString("car_model", json.optString("car_name", ""))
                val trim = json.optString("car_trim", "")
                val km = json.getInt("current_km")
                val overdueCount = json.getInt("overdue_count")
                val dueSoonCount = json.getInt("due_soon_count")
                val photoUrl = if (json.isNull("photo_url")) null else json.getString("photo_url")

                val makeLabel = listOfNotNull(
                    make.ifEmpty { null },
                    trim.ifEmpty { null }
                ).joinToString(" · ")

                views.setTextViewText(R.id.widget_car_name, model)
                views.setTextViewText(R.id.widget_make, makeLabel)
                views.setTextViewText(R.id.widget_odometer, "%,d km".format(km))
                views.setTextViewText(R.id.widget_status, when {
                    overdueCount > 0 && dueSoonCount > 0 -> "⚠ $overdueCount overdue · $dueSoonCount soon"
                    overdueCount > 0 -> "⚠ $overdueCount overdue"
                    dueSoonCount > 0 -> "$dueSoonCount due soon"
                    else -> "✓ Up to date"
                })

                if (photoUrl != null) {
                    try {
                        val bmp = fetchBitmap(photoUrl)
                        if (bmp != null) views.setImageViewBitmap(R.id.widget_photo, bmp)
                        else views.setImageViewResource(R.id.widget_photo, R.drawable.ic_car_placeholder)
                    } catch (_: Exception) {
                        views.setImageViewResource(R.id.widget_photo, R.drawable.ic_car_placeholder)
                    }
                } else {
                    views.setImageViewResource(R.id.widget_photo, R.drawable.ic_car_placeholder)
                }

                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(serverUrl))
                val pi = PendingIntent.getActivity(context, id, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widget_root, pi)

            } catch (e: Exception) {
                views.setTextViewText(R.id.widget_car_name, "Update failed")
                views.setTextViewText(R.id.widget_make, e.message?.take(60) ?: "Check server & token")
                views.setTextViewText(R.id.widget_odometer, "")
                views.setTextViewText(R.id.widget_status, "")
            }

            mgr.updateAppWidget(id, views)
        }

        private fun fetchJson(url: String): JSONObject {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            val text = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            return JSONObject(text)
        }

        private fun fetchBitmap(url: String): Bitmap? {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            val bmp = BitmapFactory.decodeStream(conn.inputStream)
            conn.disconnect()
            return bmp
        }
    }
}
