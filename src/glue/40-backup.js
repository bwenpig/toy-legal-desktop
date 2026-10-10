/* ---------- 7. JSON 備份匯入（web → 桌面遷移） ---------- */
async function importJSONBackup(){
  try{
    var path = await dlgOpen({ title: '選擇 JSON 備份檔',
      filters: [{ name: 'JSON 備份', extensions: ['json'] }], multiple: false });
    if(!path) return;
    if(Array.isArray(path)) path = path[0];
    setStatus('正在讀取備份檔…');
    var payload = JSON.parse(await fsReadText(path));
    TG.validateBackup(payload);                       // 唔啱格式即 throw
    var name = String(path).split('/').pop();
    await TG.beginRestore(payload, name);               // app 原有雙重確認 modal
    setStatus('備份檔已驗證，請在彈窗確認還原');
  }catch(e){
    setStatus('匯入失敗：' + (e.message || e));
  }
}

