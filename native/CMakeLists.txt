cmake_minimum_required(VERSION 3.19)
project(OSGSimBridge LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "OSGSimBridge requires Windows x64")
endif()
if(NOT MSVC)
  message(FATAL_ERROR "Use Visual Studio's C++ build tools")
endif()

set(SPACEXPANSE_SDK_INCLUDE_DIR "" CACHE PATH "SpaceXpansesdk/include")
set(SPACEXPANSE_CORE_IMPLIB "" CACHE FILEPATH "SDK lib/SpaceXpanse.lib")
if(NOT EXISTS "${SPACEXPANSE_SDK_INCLUDE_DIR}/SpaceXpansesdk.h")
  message(FATAL_ERROR "Set SPACEXPANSE_SDK_INCLUDE_DIR to the SDK include directory")
endif()
if(NOT EXISTS "${SPACEXPANSE_CORE_IMPLIB}")
  message(FATAL_ERROR "Set SPACEXPANSE_CORE_IMPLIB to the SDK SpaceXpanse.lib")
endif()

# Rebuild the unchanged SDK helper with the bridge's runtime and iterator settings.
# Do not also link the prebuilt SpaceXpansesdk.lib.
add_library(OSGSimBridge SHARED
  src/OSGSimBridge.cpp
  src/SpaceXpansesdk.cpp
)
set_target_properties(OSGSimBridge PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED YES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
target_include_directories(OSGSimBridge PRIVATE
  "${SPACEXPANSE_SDK_INCLUDE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_compile_options(OSGSimBridge PRIVATE /EHsc)
target_link_libraries(OSGSimBridge PRIVATE "${SPACEXPANSE_CORE_IMPLIB}" ws2_32)
target_link_options(OSGSimBridge PRIVATE /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA)
