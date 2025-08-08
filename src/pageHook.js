(function(){
  try {
    if (window.__tvfvz_hooked) return; window.__tvfvz_hooked = true;
    function tryUrl(u){
      try{
        if(!u||typeof u!=="string")return;
        if(u.indexOf('scanner.tradingview.com')===-1)return;
        var url=new URL(u, location.href);
        if(!/\/symbol(\b|\?|#|\/)/.test(url.pathname))return;
        var sym=url.searchParams.get('symbol')||'';
        if(!sym)return;
        sym=decodeURIComponent(sym).trim().replace(/\^+$/,'');
        if(!sym)return;
        window.dispatchEvent(new CustomEvent('tvfvz-symbol',{detail:sym}));
      }catch(e){}
    }
    var _fetch=window.fetch;
    if(typeof _fetch==='function'){
      window.fetch=function(input,init){
        try{var url=typeof input==='string'?input:(input&&input.url); tryUrl(url);}catch(e){}
        return _fetch.apply(this, arguments);
      };
    }
    if(window.XMLHttpRequest && window.XMLHttpRequest.prototype){
      var _open=window.XMLHttpRequest.prototype.open;
      if(_open){
        window.XMLHttpRequest.prototype.open=function(method, url){
          try{ tryUrl(url);}catch(e){}
          return _open.apply(this, arguments);
        };
      }
    }
  } catch(e) {}
})();

