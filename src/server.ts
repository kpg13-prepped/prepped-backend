import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* =========================
   CORS CONFIG (FIX)
========================= */
const allowedOrigins = [
  "https://prepped-quiz.vercel.app",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // allow server-to-server / curl / postman
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.options("*", cors());

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(cookieParser());

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("PREPPED backend running");
});

/* =========================
   ADDRESS SEARCH (LINZ)
========================= */
app.get("/api/address-search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q || q.length < 3) {
      return res.json({ results: [] });
    }

    const apiKey = process.env.LINZ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "LINZ_API_KEY not configured",
      });
    }

    const response = await fetch(
      `https://api.linz.govt.nz/search/addresses?q=${encodeURIComponent(q)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const data = await response.json();

    const results =
      data?.results?.map((item: any) => ({
        id: item.id,
        fullAddress: item.full_address,
        suburb: item.suburb,
        city: item.city,
        region: item.region,
        lat: item.latitude,
        lng: item.longitude,
      })) || [];

    res.json({ results });
  } catch (error) {
    console.error("Address search error:", error);
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Address lookup failed",
    });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = Number(process.env.PORT || 3001);

app.listen(PORT, () => {
  console.log(`PREPPED backend listening on port ${PORT}`);
});
