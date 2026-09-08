/* A main-window close request must resolve the secondary canvas first. */
(() => {
  const closeWindow=A.closeWindow;
  A.closeWindow=function(...args){
    if(S.canvasOpen&&typeof A.canvasCloseThen==='function'){
      const owner=S;return A.canvasCloseThen(()=>{if(S===owner)closeWindow.apply(A,args);});
    }
    return closeWindow.apply(A,args);
  };
})();
