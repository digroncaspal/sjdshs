export default async function handler(req, res) {
  const { from, to } = req.query;
  const KEY   = process.env.VITE_NEIS_API_KEY;
  const ATPT  = "I10";
  const SCHUL = "9300278";

  try {
    const url = `https://open.neis.go.kr/hub/SchoolSchedule?KEY=${KEY}&Type=json&ATPT_OFCDC_SC_CODE=${ATPT}&SD_SCHUL_CODE=${SCHUL}&AA_FROM_YMD=${from}&AA_TO_YMD=${to}`;
    const response = await fetch(url);
    const data = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}