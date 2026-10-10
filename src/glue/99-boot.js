/* ---------- 10. 啟動 ---------- */
if(document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', function(){ startup(); });
else
  startup();

/* 測試／除錯鉤（唯讀暴露內部函數，唔影響正常流程） */
window.__TG_DESKTOP__ = {
  migrateAttachmentsToDb: migrateAttachmentsToDb,
  extractAttachments: extractAttachments,
  reconstituteAttachments: reconstituteAttachments
};

})();
