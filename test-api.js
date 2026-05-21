import "dotenv/config";

async function testAPI() {
  const url = process.env.NUANU_API_URL;
  const apiKey = process.env.NUANU_API_KEY;

  if (!url || !apiKey) {
    console.error("❌ Set NUANU_API_URL and NUANU_API_KEY in .env (copy from .env.example)");
    process.exit(1);
  }

  console.log("Testing API connection...");
  console.log("URL:", url);

  const getRes = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });

  if (getRes.ok) {
    const data = await getRes.json();
    console.log("✅ API is live:", data);
  } else {
    console.log("❌ API returned:", getRes.status, await getRes.text());
    return;
  }

  const postRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      candidates: [
        {
          name: "Test Candidate SEEK",
          email: "test-seek-import@noemail.seek",
          phone: "+6281200000000",
          appliedRole: "Site Manager",
          seekStatus: "New",
          mostRecentRole: "Project Manager at PT Test",
          appliedAt: new Date().toISOString(),
          source: "SEEK",
        },
      ],
    }),
  });

  const result = await postRes.json();
  if (postRes.ok) {
    console.log("✅ Test candidate import:", result);
  } else {
    console.log("❌ Import failed:", result);
  }
}

testAPI().catch(console.error);
